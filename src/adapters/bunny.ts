import type { AdapterOptions, AdapterInstance, Adapter } from "../adapter.ts";
import { toBufferLike } from "../utils.ts";
import { adapterUtils, getPeers, DEFAULT_IDLE_TIMEOUT } from "../adapter.ts";
import { AdapterHookable } from "../hooks.ts";
import { Message } from "../message.ts";
import { WSError } from "../error.ts";
import { Peer, type PeerContext } from "../peer.ts";
import type { SyncDriver } from "../sync.ts";

// --- types ---

export interface BunnyAdapter extends AdapterInstance {
  handleUpgrade(req: Request): Promise<Response>;
}

export interface BunnyOptions extends AdapterOptions {
  /**
   * The WebSocket subprotocol to use for the connection.
   */
  protocol?: string;

  /**
   * The number of seconds to wait for a pong response before closing the connection.
   * If the client does not respond within this timeout, the connection is deemed
   * unhealthy and closed, emitting the close and error events.
   * If no data is transmitted from the client for 2 minutes, the connection
   * will be closed regardless of this configuration.
   *
   * @default 30
   */
  idleTimeout?: number;
}

interface BunnyUpgradeResponse {
  response: Response;
  socket: WebSocket;
}

// --- adapter ---

// https://docs.bunny.net/scripting/websockets
const bunnyAdapter: Adapter<BunnyAdapter, BunnyOptions> = (options = {}) => {
  const hooks = new AdapterHookable(options);
  const globalPeers = new Map<string, Set<BunnyPeer>>();
  const baseUtils = adapterUtils(globalPeers, options);
  return {
    ...baseUtils,
    handleUpgrade: async (request: Request & { upgradeWebSocket?: any }) => {
      if (!request.upgradeWebSocket || typeof request.upgradeWebSocket !== "function") {
        throw new Error(
          "[crossws] Bunny adapter requires the request to have an upgradeWebSocket method.",
        );
      }

      const { endResponse, context, namespace, upgradeHeaders } = await hooks.upgrade(request);
      if (endResponse) {
        return endResponse;
      }

      const headers =
        upgradeHeaders instanceof Headers ? upgradeHeaders : new Headers(upgradeHeaders);

      const negotiatedProtocol = headers.get("sec-websocket-protocol") ?? options.protocol;

      // Bunny.net specific upgrade
      const upgradeOptions: { protocol?: string; idleTimeout?: number } = {};

      if (negotiatedProtocol) {
        upgradeOptions.protocol = negotiatedProtocol;
      }

      // Default to the shared 30s (Bunny's platform default is also 30).
      upgradeOptions.idleTimeout = options.idleTimeout ?? DEFAULT_IDLE_TIMEOUT;

      const { response, socket } = request.upgradeWebSocket(
        Object.keys(upgradeOptions).length > 0 ? upgradeOptions : undefined,
      ) as BunnyUpgradeResponse;

      const remoteAddress = request.headers.get("x-real-ip") || undefined;

      // Bunny evicts the isolate once the handler returns unless it is told
      // that work is still in flight. A WebSocket outlives the handler, so hand
      // the runtime a promise that settles when the socket ends (verified
      // empirically: without this, sockets are cut with 1006 after ~10s).
      // Both `close` and `error` must settle it or a failed socket would pin
      // the isolate forever.
      let settleClosed!: () => void;
      const closed = new Promise<void>((resolve) => (settleClosed = resolve));
      (globalThis as any).Bunny?.v1?.waitUntil?.(closed);

      const peers = getPeers(globalPeers, namespace);
      const peer = new BunnyPeer({
        ws: socket,
        request,
        namespace,
        remoteAddress,
        peers,
        context,
        sync: baseUtils.sync,
      });
      peers.add(peer);

      socket.addEventListener("open", () => {
        hooks.callHook("open", peer);
      });

      socket.addEventListener("message", (event: any) => {
        hooks.callHook("message", peer, new Message(event.data, peer, event));
      });

      socket.addEventListener("close", (event: any) => {
        peers.delete(peer);
        settleClosed();
        hooks.callHook("close", peer, {
          code: event.code,
          reason: event.reason,
        });
      });

      socket.addEventListener("error", (error) => {
        peers.delete(peer);
        settleClosed();
        hooks.callHook("error", peer, new WSError(error));
      });

      return response;
    },
  };
};

export default bunnyAdapter;

// --- peer ---

class BunnyPeer extends Peer<{
  ws: WebSocket;
  request: Request;
  namespace: string;
  remoteAddress: string | undefined;
  peers: Set<BunnyPeer>;
  context: PeerContext;
  sync?: SyncDriver;
}> {
  override get remoteAddress() {
    return this._internal.remoteAddress;
  }

  send(data: unknown) {
    return this._internal.ws.send(toBufferLike(data));
  }

  _publish(topic: string, data: unknown) {
    const dataBuff = toBufferLike(data);
    for (const peer of this._internal.peers) {
      if (peer !== this && peer._topics.has(topic)) {
        peer._internal.ws.send(dataBuff);
      }
    }
  }

  close(code?: number, reason?: string) {
    this._internal.ws.close(code, reason);
  }

  override terminate(): void {
    this._internal.ws.close();
  }
}
