import type { AdapterOptions, AdapterInstance, Adapter } from "../adapter.ts";
import { toBufferLike } from "../utils.ts";
import { adapterUtils, getPeers } from "../adapter.ts";
import { AdapterHookable } from "../hooks.ts";
import { Message } from "../message.ts";
import { WSError } from "../error.ts";
import { Peer, type PeerContext } from "../peer.ts";

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer as _WebSocketServer } from "ws";
import type {
  ServerOptions,
  WebSocketServer,
  WebSocket as WebSocketT,
} from "../../types/ws";
import { StubRequest } from "../_request.ts";

// --- types ---

type AugmentedReq = IncomingMessage & {
  _request: Request;
  _upgradeHeaders?: HeadersInit;
  _context: PeerContext;
  _namespace: string;
};

export interface NodeAdapter extends AdapterInstance {
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    webRequest?: Request,
  ): Promise<void>;
  closeAll: (code?: number, data?: string | Buffer, force?: boolean) => void;
}

export interface NodeOptions extends AdapterOptions {
  wss?: WebSocketServer;
  serverOptions?: ServerOptions;
}

// --- adapter ---

// https://github.com/websockets/ws
// https://github.com/websockets/ws/blob/master/doc/ws.md
const nodeAdapter: Adapter<NodeAdapter, NodeOptions> = (options = {}) => {
  if ("Deno" in globalThis || "Bun" in globalThis) {
    throw new Error(
      "[crossws] Using Node.js adapter in an incompatible environment.",
    );
  }

  const hooks = new AdapterHookable(options);
  const globalPeers = new Map<string, Set<NodePeer>>();

  const wss: WebSocketServer =
    options.wss ||
    (new _WebSocketServer({
      noServer: true,
      ...(options.serverOptions as any),
    }) as WebSocketServer);

  wss.on("connection", (ws, nodeReq: AugmentedReq) => {
    const request = new NodeReqProxy(nodeReq);
    const peers = getPeers(globalPeers, nodeReq._namespace);
    const peer = new NodePeer({
      ws,
      request,
      peers,
      nodeReq,
      namespace: nodeReq._namespace,
    });
    peers.add(peer);
    hooks.callHook("open", peer); // ws is already open
    ws.on("message", (data: unknown) => {
      if (Array.isArray(data)) {
        data = Buffer.concat(data);
      }
      hooks.callHook("message", peer, new Message(data, peer));
    });
    ws.on("error", (error: Error) => {
      peers.delete(peer);
      hooks.callHook("error", peer, new WSError(error));
    });
    ws.on("close", (code: number, reason: Buffer) => {
      peers.delete(peer);
      hooks.callHook("close", peer, {
        code,
        reason: reason?.toString(),
      });
    });
  });

  wss.on("headers", (outgoingHeaders, req) => {
    const upgradeHeaders = (req as AugmentedReq)._upgradeHeaders;
    if (upgradeHeaders) {
      for (const [key, value] of new Headers(upgradeHeaders)) {
        outgoingHeaders.push(`${key}: ${value}`);
      }
    }
  });

  return {
    ...adapterUtils(globalPeers),
    handleUpgrade: async (nodeReq, socket, head, webRequest) => {
      const request = webRequest || new NodeReqProxy(nodeReq);

      const { upgradeHeaders, endResponse, context, namespace } =
        await hooks.upgrade(request);
      if (endResponse) {
        return sendResponse(socket, endResponse);
      }

      (nodeReq as AugmentedReq)._request = request;
      (nodeReq as AugmentedReq)._upgradeHeaders = upgradeHeaders;
      (nodeReq as AugmentedReq)._context = context;
      (nodeReq as AugmentedReq)._namespace = namespace;
      wss.handleUpgrade(nodeReq, socket, head, (ws) => {
        wss.emit("connection", ws, nodeReq);
      });
    },
    closeAll: (code, data, force) => {
      for (const client of wss.clients) {
        if (force) {
          client.terminate();
        } else {
          client.close(code, data);
        }
      }
    },
  };
};

export default nodeAdapter;

// --- peer ---

class NodePeer extends Peer<{
  peers: Set<NodePeer>;
  request: Request;
  namespace: string;
  nodeReq: IncomingMessage;
  ws: WebSocketT & { _peer?: NodePeer };
}> {
  override get remoteAddress() {
    return this._internal.nodeReq.socket?.remoteAddress;
  }

  override get context() {
    return (this._internal.nodeReq as AugmentedReq)._context;
  }

  send(data: unknown, options?: { compress?: boolean }) {
    const dataBuff = toBufferLike(data);
    const isBinary = typeof dataBuff !== "string";
    this._internal.ws.send(dataBuff, {
      compress: options?.compress,
      binary: isBinary,
      ...options,
    });
    return 0;
  }

  publish(
    topic: string,
    data: unknown,
    options?: { compress?: boolean },
  ): void {
    const dataBuff = toBufferLike(data);
    const isBinary = typeof data !== "string";
    const sendOptions = {
      compress: options?.compress,
      binary: isBinary,
      ...options,
    };
    for (const peer of this._internal.peers) {
      if (peer !== this && peer._topics.has(topic)) {
        peer._internal.ws.send(dataBuff, sendOptions);
      }
    }
  }

  close(code?: number, data?: string | Buffer) {
    this._internal.ws.close(code, data);
  }

  override terminate() {
    this._internal.ws.terminate();
  }
}

// --- web compat ---

class NodeReqProxy extends StubRequest {
  constructor(req: IncomingMessage) {
    const host = req.headers["host"] || "localhost";
    const isSecure =
      (req.socket as any)?.encrypted ??
      req.headers["x-forwarded-proto"] === "https";
    const url = `${isSecure ? "https" : "http"}://${host}${req.url}`;
    super(url, { headers: req.headers as Record<string, string> });
  }
}

async function sendResponse(socket: Duplex, res: Response) {
  const head = [
    `HTTP/1.1 ${res.status || 200} ${res.statusText || ""}`,
    ...[...res.headers.entries()].map(
      ([key, value]) =>
        `${encodeURIComponent(key)}: ${encodeURIComponent(value)}`,
    ),
  ];
  socket.write(head.join("\r\n") + "\r\n\r\n");
  if (res.body) {
    for await (const chunk of res.body) {
      socket.write(chunk);
    }
  }
  return new Promise<void>((resolve) => {
    socket.end(() => {
      socket.destroy();
      resolve();
    });
  });
}
