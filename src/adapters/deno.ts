import type { AdapterOptions, AdapterInstance, Adapter } from "../adapter.ts";
import { toBufferLike } from "../utils.ts";
import { adapterUtils, getPeers } from "../adapter.ts";
import { AdapterHookable } from "../hooks.ts";
import { Message } from "../message.ts";
import { WSError } from "../error.ts";
import { Peer, type PeerContext } from "../peer.ts";

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
  if (typeof Deno === "undefined") {
    // eslint-disable-next-line unicorn/prefer-type-error
    throw new Error(
      "[crossws] Using Deno adapter in an incompatible environment.",
    );
  }

  const hooks = new AdapterHookable(options);
  const globalPeers = new Map<string, Set<DenoPeer>>();
  return {
    ...adapterUtils(globalPeers),
    handleUpgrade: async (request, info) => {
      const { upgradeHeaders, endResponse, context, namespace } =
        await hooks.upgrade(request);
      if (endResponse) {
        return endResponse;
      }

      // prettier-ignore
      const headers = upgradeHeaders instanceof Headers ? upgradeHeaders : new Headers(upgradeHeaders);

      const upgrade = Deno.upgradeWebSocket(request, {
        // @ts-expect-error Setting headers is currently not supported in Deno
        // https://github.com/denoland/deno/issues/19277
        headers,
        protocol: headers.get("sec-websocket-protocol") ?? "",
      });

      const peers = getPeers(globalPeers, namespace);
      const peer = new DenoPeer({
        ws: upgrade.socket,
        request,
        peers,
        denoInfo: info,
        context,
        namespace,
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
    },
  };
};

export default denoAdapter;

// --- peer ---

class DenoPeer extends Peer<{
  ws: WebSocketUpgrade["socket"];
  request: Request;
  peers: Set<DenoPeer>;
  denoInfo: ServeHandlerInfo;
  context: PeerContext;
  namespace: string;
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
