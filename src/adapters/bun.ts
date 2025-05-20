import type { WebSocketHandler, ServerWebSocket, Server } from "bun";
import type { AdapterOptions, AdapterInstance, Adapter } from "../adapter.ts";
import { toBufferLike } from "../utils.ts";
import { adapterUtils, getPeers } from "../adapter.ts";
import { AdapterHookable } from "../hooks.ts";
import { Message } from "../message.ts";
import { Peer, type PeerContext } from "../peer.ts";

// --- types ---

export interface BunAdapter extends AdapterInstance {
  websocket: WebSocketHandler<ContextData>;
  handleUpgrade(req: Request, server: Server): Promise<Response | undefined>;
}

export interface BunOptions extends AdapterOptions {}

type ContextData = {
  peer?: BunPeer;
  namespace: string;
  request: Request;
  server?: Server;
  context: PeerContext;
};

// --- adapter ---

// https://bun.sh/docs/api/websockets
const bunAdapter: Adapter<BunAdapter, BunOptions> = (options = {}) => {
  if (typeof Bun === "undefined") {
    // eslint-disable-next-line unicorn/prefer-type-error
    throw new Error(
      "[crossws] Using Bun adapter in an incompatible environment.",
    );
  }

  const hooks = new AdapterHookable(options);
  const globalPeers = new Map<string, Set<BunPeer>>();
  return {
    ...adapterUtils(globalPeers),
    async handleUpgrade(request, server) {
      const { upgradeHeaders, endResponse, context, namespace } =
        await hooks.upgrade(request);
      if (endResponse) {
        return endResponse;
      }
      const upgradeOK = server.upgrade(request, {
        data: {
          server,
          request,
          context,
          namespace,
        } satisfies ContextData,
        headers: upgradeHeaders,
      });

      if (!upgradeOK) {
        return new Response("Upgrade failed", { status: 500 });
      }
    },
    websocket: {
      message: (ws, message) => {
        const peers = getPeers(globalPeers, ws.data.namespace);
        const peer = getPeer(ws, peers);
        hooks.callHook("message", peer, new Message(message, peer));
      },
      open: (ws) => {
        const peers = getPeers(globalPeers, ws.data.namespace);
        const peer = getPeer(ws, peers);
        peers.add(peer);
        hooks.callHook("open", peer);
      },
      close: (ws, code, reason) => {
        const peers = getPeers(globalPeers, ws.data.namespace);
        const peer = getPeer(ws, peers);
        peers.delete(peer);
        hooks.callHook("close", peer, { code, reason });
      },
    },
  };
};

export default bunAdapter;

// --- peer ---

function getPeer(
  ws: ServerWebSocket<ContextData>,
  peers: Set<BunPeer>,
): BunPeer {
  if (ws.data.peer) {
    return ws.data.peer;
  }
  const peer = new BunPeer({
    ws,
    request: ws.data.request,
    peers,
    namespace: ws.data.namespace,
  });
  ws.data.peer = peer;
  return peer;
}

class BunPeer extends Peer<{
  ws: ServerWebSocket<ContextData>;
  namespace: string;
  request: Request;
  peers: Set<BunPeer>;
}> {
  override get remoteAddress(): string {
    return this._internal.ws.remoteAddress;
  }

  override get context(): PeerContext {
    return this._internal.ws.data.context;
  }

  send(data: unknown, options?: { compress?: boolean }): number {
    return this._internal.ws.send(toBufferLike(data), options?.compress);
  }

  publish(
    topic: string,
    data: unknown,
    options?: { compress?: boolean },
  ): number {
    return this._internal.ws.publish(
      topic,
      toBufferLike(data),
      options?.compress,
    );
  }

  override subscribe(topic: string): void {
    this._topics.add(topic);
    this._internal.ws.subscribe(topic);
  }

  override unsubscribe(topic: string): void {
    this._topics.delete(topic);
    this._internal.ws.unsubscribe(topic);
  }

  close(code?: number, reason?: string): void {
    this._internal.ws.close(code, reason);
  }

  override terminate(): void {
    this._internal.ws.terminate();
  }
}
