import type { AdapterOptions, AdapterInstance, Adapter } from "../adapter.ts";
import { toBufferLike } from "../utils.ts";
import { adapterUtils } from "../adapter.ts";
import { AdapterHookable } from "../hooks.ts";
import { Message } from "../message.ts";
import { WSError } from "../error.ts";
import { Peer, type PeerContext } from "../peer.ts";

import type * as _cf from "@cloudflare/workers-types";

// --- types ---

declare const WebSocketPair: typeof _cf.WebSocketPair;
declare const Response: typeof _cf.Response;

export interface CloudflareAdapter extends AdapterInstance {
  handleUpgrade(
    req: _cf.Request,
    env: unknown,
    context: _cf.ExecutionContext,
  ): Promise<_cf.Response>;
}

export interface CloudflareOptions extends AdapterOptions {}

// --- adapter ---

// https://developers.cloudflare.com/workers/examples/websockets/
const cloudflareAdapter: Adapter<CloudflareAdapter, CloudflareOptions> = (
  options = {},
) => {
  const hooks = new AdapterHookable(options);
  const peers = new Set<CloudflarePeer>();
  return {
    ...adapterUtils(peers),
    handleUpgrade: async (request, env, cfCtx) => {
      const { upgradeHeaders, endResponse, context } = await hooks.upgrade(
        request as unknown as Request,
      );
      if (endResponse) {
        return endResponse as unknown as _cf.Response;
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      const peer = new CloudflarePeer({
        ws: client,
        peers,
        wsServer: server,
        request: request as unknown as Request,
        cfEnv: env,
        cfCtx: cfCtx,
        context,
      });
      peers.add(peer);
      server.accept();
      hooks.callHook("open", peer);
      server.addEventListener("message", (event) => {
        hooks.callHook(
          "message",
          peer,
          new Message(event.data, peer, event as MessageEvent),
        );
      });
      server.addEventListener("error", (event) => {
        peers.delete(peer);
        hooks.callHook("error", peer, new WSError(event.error));
      });
      server.addEventListener("close", (event) => {
        peers.delete(peer);
        hooks.callHook("close", peer, event);
      });
      // eslint-disable-next-line unicorn/no-null
      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: upgradeHeaders,
      });
    },
  };
};

export default cloudflareAdapter;

// --- peer ---

class CloudflarePeer extends Peer<{
  ws: _cf.WebSocket;
  request: Request;
  peers: Set<CloudflarePeer>;
  wsServer: _cf.WebSocket;
  cfEnv: unknown;
  cfCtx: _cf.ExecutionContext;
  context: PeerContext;
}> {
  send(data: unknown) {
    this._internal.wsServer.send(toBufferLike(data));
    return 0;
  }

  publish(_topic: string, _message: any): void {
    // not supported
  }

  close(code?: number, reason?: string) {
    this._internal.ws.close(code, reason);
  }
}
