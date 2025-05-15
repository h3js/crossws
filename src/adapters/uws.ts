import type { AdapterOptions, AdapterInstance, Adapter } from "../adapter.ts";
import type { WebSocket } from "../../types/web.ts";
import type uws from "uWebSockets.js";
import { toBufferLike } from "../utils.ts";
import { adapterUtils } from "../adapter.ts";
import { AdapterHookable } from "../hooks.ts";
import { Message } from "../message.ts";
import { Peer, type PeerContext } from "../peer.ts";
import { StubRequest } from "../_request.ts";

// --- types ---

type UserData = {
  peer?: UWSPeer;
  req: uws.HttpRequest;
  res: uws.HttpResponse;
  protocol: string;
  extensions: string;
  context: PeerContext;
};

type WebSocketHandler = uws.WebSocketBehavior<UserData>;

export interface UWSAdapter extends AdapterInstance {
  websocket: WebSocketHandler;
}

export interface UWSOptions extends AdapterOptions {
  uws?: Exclude<
    uws.WebSocketBehavior<any>,
    | "close"
    | "drain"
    | "message"
    | "open"
    | "ping"
    | "pong"
    | "subscription"
    | "upgrade"
  >;
}

// --- adapter ---

// https://github.com/websockets/ws
// https://github.com/websockets/ws/blob/master/doc/ws.md
const uwsAdapter: Adapter<UWSAdapter, UWSOptions> = (options = {}) => {
  const hooks = new AdapterHookable(options);
  const peers = new Set<UWSPeer>();
  return {
    ...adapterUtils(peers),
    websocket: {
      ...options.uws,
      close(ws, code, message) {
        const peer = getPeer(ws, peers);
        ((peer as any)._internal.ws as UwsWebSocketProxy).readyState =
          2 /* CLOSING */;
        peers.delete(peer);
        hooks.callHook("close", peer, {
          code,
          reason: message?.toString(),
        });
        ((peer as any)._internal.ws as UwsWebSocketProxy).readyState =
          3 /* CLOSED */;
      },
      message(ws, message, isBinary) {
        const peer = getPeer(ws, peers);
        hooks.callHook("message", peer, new Message(message, peer));
      },
      open(ws) {
        const peer = getPeer(ws, peers);
        peers.add(peer);
        hooks.callHook("open", peer);
      },
      async upgrade(res, req, uwsContext) {
        let aborted = false;
        res.onAborted(() => {
          aborted = true;
        });

        const { upgradeHeaders, endResponse, context } = await hooks.upgrade(
          new UWSReqProxy(req),
        );
        if (endResponse) {
          res.writeStatus(`${endResponse.status} ${endResponse.statusText}`);
          for (const [key, value] of endResponse.headers) {
            res.writeHeader(key, value);
          }
          if (endResponse.body) {
            for await (const chunk of endResponse.body) {
              if (aborted) break;
              res.write(chunk);
            }
          }
          if (!aborted) {
            res.end();
          }
          return;
        }

        if (aborted) {
          return;
        }

        res.writeStatus("101 Switching Protocols");
        if (upgradeHeaders) {
          // prettier-ignore
          const headers = upgradeHeaders instanceof Headers ? upgradeHeaders : new Headers(upgradeHeaders);
          for (const [key, value] of headers) {
            res.writeHeader(key, value);
          }
        }

        res.cork(() => {
          const key = req.getHeader("sec-websocket-key");
          const protocol = req.getHeader("sec-websocket-protocol");
          const extensions = req.getHeader("sec-websocket-extensions");
          res.upgrade(
            {
              req,
              res,
              protocol,
              extensions,
              context,
            },
            key,
            protocol,
            extensions,
            uwsContext,
          );
        });
      },
    },
  };
};

export default uwsAdapter;

// --- peer ---

function getPeer(uws: uws.WebSocket<UserData>, peers: Set<UWSPeer>): UWSPeer {
  const uwsData = uws.getUserData();
  if (uwsData.peer) {
    return uwsData.peer;
  }
  const peer = new UWSPeer({
    peers,
    uws,
    ws: new UwsWebSocketProxy(uws),
    request: new UWSReqProxy(uwsData.req),
    uwsData,
  });
  uwsData.peer = peer;
  return peer;
}

class UWSPeer extends Peer<{
  peers: Set<UWSPeer>;
  request: UWSReqProxy;
  uws: uws.WebSocket<UserData>;
  ws: UwsWebSocketProxy;
  uwsData: UserData;
}> {
  override get remoteAddress(): string | undefined {
    try {
      const addr = new TextDecoder().decode(
        this._internal.uws.getRemoteAddressAsText(),
      );
      return addr;
    } catch {
      // Error: Invalid access of closed uWS.WebSocket/SSLWebSocket.
    }
  }

  override get context(): PeerContext {
    return this._internal.uwsData.context;
  }

  send(data: unknown, options?: { compress?: boolean }): number {
    const dataBuff = toBufferLike(data);
    const isBinary = typeof dataBuff !== "string";
    return this._internal.uws.send(dataBuff, isBinary, options?.compress);
  }

  override subscribe(topic: string): void {
    this._topics.add(topic);
    this._internal.uws.subscribe(topic);
  }

  override unsubscribe(topic: string): void {
    this._topics.delete(topic);
    this._internal.uws.unsubscribe(topic);
  }

  publish(topic: string, message: string, options?: { compress?: boolean }) {
    const data = toBufferLike(message);
    const isBinary = typeof data !== "string";
    this._internal.uws.publish(topic, data, isBinary, options?.compress);
    return 0;
  }

  close(code?: number, reason?: uws.RecognizedString): void {
    this._internal.uws.end(code, reason);
  }

  override terminate(): void {
    this._internal.uws.close();
  }
}

// --- web compat ---

class UWSReqProxy extends StubRequest {
  constructor(req: uws.HttpRequest) {
    const rawHeaders: [string, string][] = [];

    let host = "localhost";
    let proto = "http";

    // eslint-disable-next-line unicorn/no-array-for-each
    req.forEach((key, value) => {
      if (key === "host") {
        host = value;
      } else if (key === "x-forwarded-proto" && value === "https") {
        proto = "https";
      }
      rawHeaders.push([key, value]);
    });

    const query = req.getQuery();
    const pathname = req.getUrl();
    const url = `${proto}://${host}${pathname}${query ? `?${query}` : ""}`;

    super(url, { headers: rawHeaders });
  }
}

class UwsWebSocketProxy implements Partial<WebSocket> {
  readyState?: number = 1 /* OPEN */;

  constructor(private _uws: uws.WebSocket<UserData>) {}

  get bufferedAmount(): number {
    return this._uws?.getBufferedAmount();
  }

  get protocol(): string {
    return this._uws?.getUserData().protocol;
  }

  get extensions(): string {
    return this._uws?.getUserData().extensions;
  }
}
