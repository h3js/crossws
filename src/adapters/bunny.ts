import type { AdapterOptions, AdapterInstance, Adapter } from "../adapter.ts";
import { toBufferLike } from "../utils.ts";
import { adapterUtils, getPeers } from "../adapter.ts";
import { AdapterHookable } from "../hooks.ts";
import { Message } from "../message.ts";
import { WSError } from "../error.ts";
import { Peer, type PeerContext } from "../peer.ts";

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

interface BunnyWebSocket extends EventTarget {
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

interface BunnyUpgradeResponse {
  response: Response;
  socket: BunnyWebSocket;
}

// --- adapter ---

// https://docs.bunny.net/scripting/websockets
const bunnyAdapter: Adapter<BunnyAdapter, BunnyOptions> = (options = {}) => {
  const hooks = new AdapterHookable(options);
  const globalPeers = new Map<string, Set<BunnyPeer>>();
  return {
    ...adapterUtils(globalPeers),
    handleUpgrade: async (request: Request & { upgradeWebSocket?: any }) => {
      const { endResponse, context, namespace } = await hooks.upgrade(request);
      if (endResponse) {
        return endResponse;
      }

      // Bunny.net specific upgrade
      const upgradeOptions: { protocol?: string; idleTimeout?: number } = {};
      if (options.protocol) {
        upgradeOptions.protocol = options.protocol;
      }
      if (options.idleTimeout !== undefined) {
        upgradeOptions.idleTimeout = options.idleTimeout;
      }

      const { response, socket } = request.upgradeWebSocket(
        Object.keys(upgradeOptions).length > 0 ? upgradeOptions : undefined,
      ) as BunnyUpgradeResponse;

      const peers = getPeers(globalPeers, namespace);
      const peer = new BunnyPeer({
        ws: socket,
        request,
        peers,
        context,
        namespace,
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
        hooks.callHook("close", peer, {
          code: event.code,
          reason: event.reason,
        });
      });

      socket.addEventListener("error", (error) => {
        peers.delete(peer);
        hooks.callHook("error", peer, new WSError(error));
      });

      return response;
    },
  };
};

export default bunnyAdapter;

// --- peer ---

class BunnyPeer extends Peer<{
  ws: BunnyWebSocket;
  request: Request;
  peers: Set<BunnyPeer>;
  context: PeerContext;
  namespace: string;
}> {
  send(data: unknown) {
    return this._internal.ws.send(toBufferLike(data));
  }

  publish(topic: string, data: unknown) {
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
