import type { AdapterOptions, AdapterInstance, Adapter } from "../adapter.ts";
import { toBufferLike } from "../utils.ts";
import { adapterUtils } from "../adapter.ts";
import { AdapterHookable } from "../hooks.ts";
import { Message } from "../message.ts";
import { WSError } from "../error.ts";
import { Peer } from "../peer.ts";

// --- types ---

export interface DenoAdapter extends AdapterInstance {
  handleUpgrade(req: Request, info: ServeHandlerInfo): Promise<Response>;
}

export interface DenoOptions extends AdapterOptions {}

type WebSocketUpgrade = Deno.WebSocketUpgrade;
type ServeHandlerInfo = {
  remoteAddr?: { transport: string; hostname: string; port: number };
};

// --- adapter ---

// https://deno.land/api?s=WebSocket
// https://deno.land/api?s=Deno.upgradeWebSocket
// https://examples.deno.land/http-server-websocket
const denoAdapter: Adapter<DenoAdapter, DenoOptions> = (options = {}) => {
  const hooks = new AdapterHookable(options);
  const peers = new Set<DenoPeer>();

  const handleUpgrade = async (request: Request, info: ServeHandlerInfo) => {
    const { upgradeHeaders, endResponse, context } =
      await hooks.upgrade(request);
    if (endResponse) {
      return endResponse;
    }

    const upgrade = Deno.upgradeWebSocket(request, {
      // @ts-expect-error https://github.com/denoland/deno/pull/22242
      headers: upgradeHeaders,
    });
    const peer = new DenoPeer({
      ws: upgrade.socket,
      request,
      peers,
      denoInfo: info,
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
      peers.delete(peer);
      hooks.callHook("error", peer, new WSError(error));
    });
    return upgrade.response;
  };

  return {
    ...adapterUtils(peers),
    handleUpgrade,
    _srvxUpgrade: (request) =>
      handleUpgrade(request, request.runtime!.deno!.info),
  };
};

export default denoAdapter;

// --- peer ---

class DenoPeer extends Peer<{
  ws: WebSocketUpgrade["socket"];
  request: Request;
  peers: Set<DenoPeer>;
  denoInfo: ServeHandlerInfo;
  context: Peer["context"];
}> {
  override get remoteAddress() {
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

  override terminate(): void {
    (this._internal.ws as any).terminate();
  }
}
