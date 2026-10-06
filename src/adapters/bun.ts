import type { WebSocketHandler, ServerWebSocket, Server } from "bun";
import type { AdapterInstance, Adapter } from "../adapter.ts";
import type { BunOptions } from "./_options.ts";
import { toBufferLike } from "../utils.ts";
import { adapterUtils, getPeers, DEFAULT_IDLE_TIMEOUT } from "../adapter.ts";
import { AdapterHookable } from "../hooks.ts";
import { Message } from "../message.ts";
import { WSError } from "../error.ts";
import { Peer, type PeerContext } from "../peer.ts";
import type { SyncDriver } from "../sync.ts";

// --- types ---

export interface BunAdapter extends AdapterInstance {
  websocket: WebSocketHandler<ContextData>;
  handleUpgrade(req: Request, server: Server<ContextData>): Promise<Response | undefined>;
}

export type { BunOptions } from "./_options.ts";

type ContextData = {
  peer?: BunPeer;
  namespace: string;
  request: Request;
  server?: Server<ContextData>;
  context: PeerContext;
};

// --- adapter ---

// https://bun.sh/docs/api/websockets
const bunAdapter: Adapter<BunAdapter, BunOptions> = (options = {}) => {
  if (typeof Bun === "undefined") {
    // eslint-disable-next-line unicorn/prefer-type-error
    throw new Error("[crossws] Using Bun adapter in an incompatible environment.");
  }

  const hooks = new AdapterHookable(options);
  const globalPeers = new Map<string, Set<BunPeer>>();
  const baseUtils = adapterUtils(globalPeers, options, { nativePubSub: true });
  return {
    ...baseUtils,
    async handleUpgrade(request, server) {
      const { upgradeHeaders, endResponse, context, namespace } = await hooks.upgrade(request);
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
      // Map the shared `idleTimeout` (seconds, default 30) onto Bun's native
      // option. Bun auto-sends keepalive pings (`sendPings` defaults to `true`)
      // and closes a connection idle beyond this, so half-open sockets can't
      // leak. `0` disables it.
      idleTimeout: options.idleTimeout ?? DEFAULT_IDLE_TIMEOUT,
      message: (ws, message) => {
        const peers = getPeers(globalPeers, ws.data.namespace);
        const peer = getPeer(ws, peers, baseUtils.sync, hooks);
        hooks.callHook("message", peer, new Message(message, peer));
      },
      open: (ws) => {
        const peers = getPeers(globalPeers, ws.data.namespace);
        const peer = getPeer(ws, peers, baseUtils.sync, hooks);
        peers.add(peer);
        hooks.callHook("open", peer);
      },
      close: (ws, code, reason) => {
        const peers = getPeers(globalPeers, ws.data.namespace);
        const peer = getPeer(ws, peers, baseUtils.sync, hooks);
        peers.delete(peer);
        hooks.callHook("close", peer, { code, reason });
      },
      drain: (ws) => {
        const peers = getPeers(globalPeers, ws.data.namespace);
        const peer = getPeer(ws, peers, baseUtils.sync, hooks);
        hooks.callHook("drain", peer);
      },
      // Bun auto-replies to an inbound ping with a pong per the spec; these
      // hooks only observe the control frames, they don't need to answer them.
      ping: (ws, data) => {
        const peers = getPeers(globalPeers, ws.data.namespace);
        const peer = getPeer(ws, peers, baseUtils.sync, hooks);
        hooks.callHook("ping", peer, data);
      },
      pong: (ws, data) => {
        const peers = getPeers(globalPeers, ws.data.namespace);
        const peer = getPeer(ws, peers, baseUtils.sync, hooks);
        hooks.callHook("pong", peer, data);
      },
    },
  };
};

export default bunAdapter;

// --- peer ---

function getPeer(
  ws: ServerWebSocket<ContextData>,
  peers: Set<BunPeer>,
  sync: SyncDriver | undefined,
  hooks: AdapterHookable,
): BunPeer {
  if (ws.data.peer) {
    return ws.data.peer;
  }
  const peer = new BunPeer({
    ws,
    request: ws.data.request,
    peers,
    namespace: ws.data.namespace,
    sync,
    hooks,
  });
  ws.data.peer = peer;
  return peer;
}

class BunPeer extends Peer<{
  ws: ServerWebSocket<ContextData>;
  namespace: string;
  request: Request;
  peers: Set<BunPeer>;
  sync?: SyncDriver;
  hooks: AdapterHookable;
}> {
  override get remoteAddress(): string {
    return this._internal.ws.remoteAddress;
  }

  override get context(): PeerContext {
    return this._internal.ws.data.context;
  }

  override get bufferedAmount(): number {
    return this._internal.ws.getBufferedAmount();
  }

  send(data: unknown, options?: { compress?: boolean }): number {
    return this._internal.ws.send(toBufferLike(data), options?.compress);
  }

  _publish(topic: string, data: unknown, options?: { compress?: boolean }): number {
    return this._internal.ws.publish(topic, toBufferLike(data), options?.compress);
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

  override ping(data?: unknown): number {
    // Guard against the native ping rejecting the payload (e.g. the 125-byte
    // control-frame limit): surface it through the `error` hook rather than
    // letting it crash a caller inside a hook handler.
    try {
      return this._internal.ws.ping(data as any);
    } catch (error) {
      this._internal.hooks.callHook("error", this, new WSError(error));
      return 0;
    }
  }
}
