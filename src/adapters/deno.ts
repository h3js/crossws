import type { AdapterOptions, AdapterInstance } from "../adapter.ts";
import { toBufferLike } from "../utils.ts";
import { defineWebSocketAdapter, adapterUtils } from "../adapter.ts";
import { AdapterHookable } from "../hooks.ts";
import { Message } from "../message.ts";
import { WSError } from "../error.ts";
import { Peer } from "../peer.ts";

// --- types ---

export interface DenoAdapter extends AdapterInstance {
  handleUpgrade(req: Request, info: ServeHandlerInfo): Promise<Response>;
}

export interface DenoOptions extends AdapterOptions {}

declare global {
  const Deno: typeof import("@deno/types").Deno;
}

type WebSocketUpgrade = import("@deno/types").Deno.WebSocketUpgrade;
type ServeHandlerInfo = {
  remoteAddr?: { transport: string; hostname: string; port: number };
};

// --- adapter ---

// https://deno.land/api?s=WebSocket
// https://deno.land/api?s=Deno.upgradeWebSocket
// https://examples.deno.land/http-server-websocket
export default defineWebSocketAdapter<DenoAdapter, DenoOptions>(
  (options = {}) => {
    const hooks = new AdapterHookable(options);
    const peers = new Set<DenoPeer>();
    return {
      ...adapterUtils(peers),
      handleUpgrade: async (request, info) => {
        const res = await hooks.callHook("upgrade", request);
        if (res instanceof Response) {
          return res;
        }
        const upgrade = Deno.upgradeWebSocket(request, {
          // @ts-expect-error https://github.com/denoland/deno/pull/22242
          headers: res?.headers,
        });
        const peer = new DenoPeer({
          ws: upgrade.socket,
          request,
          peers,
          denoInfo: info,
        });
        peers.add(peer);
        upgrade.socket.addEventListener("open", () => {
          hooks.callAdapterHook("deno:open", peer);
          hooks.callHook("open", peer);
        });
        upgrade.socket.addEventListener("message", (event) => {
          hooks.callAdapterHook("deno:message", peer, event);
          hooks.callHook("message", peer, new Message(event.data, peer, event));
        });
        upgrade.socket.addEventListener("close", () => {
          peers.delete(peer);
          hooks.callAdapterHook("deno:close", peer);
          hooks.callHook("close", peer, {});
        });
        upgrade.socket.addEventListener("error", (error) => {
          peers.delete(peer);
          hooks.callAdapterHook("deno:error", peer, error);
          hooks.callHook("error", peer, new WSError(error));
        });
        return upgrade.response;
      },
    };
  },
);

// --- peer ---

class DenoPeer extends Peer<{
  ws: WebSocketUpgrade["socket"];
  request: Request;
  peers: Set<DenoPeer>;
  denoInfo: ServeHandlerInfo;
}> {
  get remoteAddress() {
    return this._internal.denoInfo.remoteAddr?.hostname;
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

  terminate(): void {
    (this._internal.ws as any).terminate();
  }
}
