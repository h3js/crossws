import type { AdapterOptions, AdapterInstance, Adapter } from "../adapter.ts";
import type * as web from "../../types/web.ts";
import { toString } from "../utils.ts";
import { adapterUtils, getPeers } from "../adapter.ts";
import { AdapterHookable } from "../hooks.ts";
import { Message } from "../message.ts";
import { Peer, type PeerContext } from "../peer.ts";

// --- types ---

export interface SSEAdapter extends AdapterInstance {
  fetch(req: Request): Promise<Response>;
}

export interface SSEOptions extends AdapterOptions {
  bidir?: boolean;
}

// --- adapter ---

// https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events
const sseAdapter: Adapter<SSEAdapter, SSEOptions> = (opts = {}) => {
  const hooks = new AdapterHookable(opts);
  const globalPeers = new Map<string, Set<SSEPeer>>();
  const peersMap = opts.bidir ? new Map<string, SSEPeer>() : undefined;

  return {
    ...adapterUtils(globalPeers),
    fetch: async (request: Request) => {
      const { upgradeHeaders, endResponse, context, namespace } =
        await hooks.upgrade(request);
      if (endResponse) {
        return endResponse;
      }

      let peer: SSEPeer;

      if (opts.bidir && request.body && request.headers.has("x-crossws-id")) {
        // Accept bidirectional streaming request
        const id = request.headers.get("x-crossws-id")!;
        peer = peersMap?.get(id) as SSEPeer;
        if (!peer) {
          return new Response("invalid peer id", { status: 400 });
        }
        const stream = request.body.pipeThrough(new TextDecoderStream());
        try {
          for await (const chunk of stream) {
            hooks.callHook("message", peer, new Message(chunk, peer));
          }
        } catch {
          await stream.cancel().catch(() => {});
        }
        // eslint-disable-next-line unicorn/no-null
        return new Response(null, {});
      } else {
        // Add a new peer
        const ws = new SSEWebSocketStub();
        const peers = getPeers(globalPeers, namespace);
        peer = new SSEPeer({
          peers,
          peersMap,
          request,
          hooks,
          ws,
          context,
          namespace,
        });
        peers.add(peer);
        if (opts.bidir) {
          peersMap!.set(peer.id, peer);
          peer._sendEvent("crossws-id", peer.id);
        }
      }

      let headers: HeadersInit = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      };

      if (opts.bidir) {
        headers["x-crossws-id"] = peer.id;
      }

      if (upgradeHeaders) {
        headers = new Headers(headers);
        for (const [key, value] of new Headers(upgradeHeaders)) {
          headers.set(key, value);
        }
      }

      return new Response(peer._sseStream, { headers });
    },
  };
};

export default sseAdapter;

// --- peer ---

class SSEPeer extends Peer<{
  peers: Set<SSEPeer>;
  peersMap?: Map<string, SSEPeer>;
  request: Request;
  ws: SSEWebSocketStub;
  hooks: AdapterHookable;
  context: PeerContext;
  namespace: string;
}> {
  _sseStream: ReadableStream; // server -> client
  _sseStreamController?: ReadableStreamDefaultController;

  constructor(_internal: SSEPeer["_internal"]) {
    super(_internal);
    _internal.ws.readyState = 0 /* CONNECTING */;
    this._sseStream = new ReadableStream({
      start: (controller) => {
        _internal.ws.readyState = 1 /* OPEN */;
        this._sseStreamController = controller;
        _internal.hooks.callHook("open", this);
      },
      cancel: () => {
        _internal.ws.readyState = 2 /* CLOSING */;
        _internal.peers.delete(this);
        _internal.peersMap?.delete(this.id);
        Promise.resolve(this._internal.hooks.callHook("close", this)).finally(
          () => {
            _internal.ws.readyState = 3 /* CLOSED */;
          },
        );
      },
    }).pipeThrough(new TextEncoderStream());
  }

  _sendEvent(event: string, data: string) {
    const lines = data.split("\n");
    this._sseStreamController?.enqueue(
      `event: ${event}\n${lines.map((l) => `data: ${l}`)}\n\n`,
    );
  }

  send(data: unknown) {
    this._sendEvent("message", toString(data));
    return 0;
  }

  publish(topic: string, data: unknown) {
    const dataBuff = toString(data);
    for (const peer of this._internal.peers) {
      if (peer !== this && peer._topics.has(topic)) {
        peer._sendEvent("message", dataBuff);
      }
    }
  }

  close() {
    this._sseStreamController?.close();
  }
}

// --- web compat ---

class SSEWebSocketStub implements Partial<web.WebSocket> {
  readyState?: number | undefined;
}
