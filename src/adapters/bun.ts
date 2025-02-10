import type { WebSocketHandler, ServerWebSocket, Server } from "bun";
import type { AdapterOptions, AdapterInstance, Adapter } from "../adapter.ts";
import { toBufferLike } from "../utils.ts";
import { adapterUtils } from "../adapter.ts";
import { AdapterHookable } from "../hooks.ts";
import { Message } from "../message.ts";
import { Peer } from "../peer.ts";

// --- types ---

export interface BunAdapter extends AdapterInstance {
  websocket: WebSocketHandler<ContextData>;
  handleUpgrade(req: Request, server: Server): Promise<Response | undefined>;
}

export interface BunOptions extends AdapterOptions {}

type ContextData = {
  peer?: BunPeer;
  request: Request;
  server?: Server;
  context: Peer["context"];
};

// --- adapter ---

// https://bun.sh/docs/api/websockets
const bunAdapter: Adapter<BunAdapter, BunOptions> = (options = {}) => {
  const hooks = new AdapterHookable(options);
  const peers = new Set<BunPeer>();
  return {
    ...adapterUtils(peers),
    async handleUpgrade(request, server) {
      const { upgradeHeaders, endResponse, context } =
        await hooks.upgrade(request);
      if (endResponse) {
        return endResponse;
      }
      const upgradeOK = server.upgrade(request, {
        data: {
          server,
          request,
          context,
        } satisfies ContextData,
        headers: upgradeHeaders,
      });

      if (!upgradeOK) {
        return new Response("Upgrade failed", { status: 500 });
      }
    },
    websocket: {
      message: (ws, message) => {
        const peer = getPeer(ws, peers);
        hooks.callHook("message", peer, new Message(message, peer));
      },
      open: (ws) => {
        const peer = getPeer(ws, peers);
        peers.add(peer);
        hooks.callHook("open", peer);
      },
      close: (ws) => {
        const peer = getPeer(ws, peers);
        peers.delete(peer);
        hooks.callHook("close", peer, {});
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
  if (ws.data?.peer) {
    return ws.data.peer;
  }
  const peer = new BunPeer({ ws, request: ws.data.request, peers });
  ws.data = {
    ...ws.data,
    peer,
  };
  return peer;
}

class BunPeer extends Peer<{
  ws: ServerWebSocket<ContextData>;
  request: Request;
  peers: Set<BunPeer>;
}> {
  override get remoteAddress(): string {
    return this._internal.ws.remoteAddress;
  }

  override get context(): Peer["context"] {
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
