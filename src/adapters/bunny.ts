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
    handleUpgrade: async (
      request: Request & { upgradeWebSocket?: any },
      denoInfo: { remoteAddr?: Deno.NetAddr } = {},
    ) => {
      const { endResponse, context, namespace, upgradeHeaders } =
        await hooks.upgrade(request);
      if (endResponse) {
        return endResponse;
      }

      const headers =
        upgradeHeaders instanceof Headers
          ? upgradeHeaders
          : new Headers(upgradeHeaders);

      const negotiatedProtocol =
        headers.get("sec-websocket-protocol") ?? options.protocol;

      // Fallback to Deno upgrade for local development
      if (!request.upgradeWebSocket && typeof Deno !== "undefined") {
        const upgrade = Deno.upgradeWebSocket(request, {
          protocol: negotiatedProtocol ?? "",
        });
        const peers = getPeers(globalPeers, namespace);
        const peer = new BunnyPeer({
          ws: upgrade.socket,
          request,
          namespace,
          remoteAddress: denoInfo.remoteAddr?.hostname,
          peers,
          context,
        });
        peers.add(peer);
        upgrade.socket.addEventListener("open", () => {
          hooks.callHook("open", peer);
        });
        upgrade.socket.addEventListener("message", (event) => {
          hooks.callHook("message", peer, new Message(event.data, peer, event));
        });
        upgrade.socket.addEventListener("close", () => {
          peers.delete(peer);
          hooks.callHook("close", peer, {});
        });
        upgrade.socket.addEventListener("error", (error) => {
          hooks.callHook("error", peer, new WSError(error));
        });
        return upgrade.response;
      }

      // Bunny.net specific upgrade
      const upgradeOptions: { protocol?: string; idleTimeout?: number } = {};

      if (negotiatedProtocol) {
        upgradeOptions.protocol = negotiatedProtocol;
      }

      if (options.idleTimeout !== undefined) {
        upgradeOptions.idleTimeout = options.idleTimeout;
      }

      const { response, socket } = request.upgradeWebSocket(
        Object.keys(upgradeOptions).length > 0 ? upgradeOptions : undefined,
      ) as BunnyUpgradeResponse;

      const remoteAddress =
        request.headers.get("x-forwarded-for")?.split(",").shift()?.trim() ||
        request.headers.get("x-real-ip") ||
        undefined;

      const peers = getPeers(globalPeers, namespace);
      const peer = new BunnyPeer({
        ws: socket,
        request,
        namespace,
        remoteAddress,
        peers,
        context,
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
        // Note: on idle timeout Bunny.net will emit both "error" and "close" events,
        // so the peer will already be deleted when we receive the "error" event.
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
  namespace: string;
  remoteAddress: string | undefined;
  peers: Set<BunnyPeer>;
  context: PeerContext;
}> {
  override get remoteAddress() {
    return this._internal.remoteAddress;
  }

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
