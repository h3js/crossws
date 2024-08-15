import type { AdapterOptions, AdapterInstance } from "../adapter.ts";
import type * as web from "../../types/web.ts";
import { toBufferLike } from "../utils.ts";
import { defineWebSocketAdapter, adapterUtils } from "../adapter.ts";
import { AdapterHookable } from "../hooks.ts";
import { Message } from "../message.ts";
import { Peer } from "../peer.ts";

import type * as CF from "@cloudflare/workers-types";
import type { DurableObject } from "cloudflare:workers";

// https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/

export default defineWebSocketAdapter<
  CloudflareDurableAdapter,
  CloudflareOptions
>((opts) => {
  const hooks = new AdapterHookable(opts);
  const peers = new Set<CloudflareDurablePeer>();
  return {
    ...adapterUtils(peers),
    handleUpgrade: async (req, env, _context) => {
      const bindingName = opts?.bindingName ?? "$DurableObject";
      const instanceName = opts?.instanceName ?? "crossws";
      const binding = (env as any)[bindingName] as CF.DurableObjectNamespace;
      const id = binding.idFromName(instanceName);
      const stub = binding.get(id);
      return stub.fetch(req as CF.Request) as unknown as Response;
    },
    handleDurableInit: async (obj, state, env) => {
      // placeholder
    },
    handleDurableUpgrade: async (obj, request) => {
      const res = await hooks.callHook("upgrade", request as Request);
      if (res instanceof Response) {
        return res;
      }
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      const peer = CloudflareDurablePeer._restore(
        obj,
        server as unknown as CF.WebSocket,
        request,
      );
      peers.add(peer);
      (obj as DurableObjectPub).ctx.acceptWebSocket(server);
      await hooks.callAdapterHook("cloudflare:accept", peer);
      await hooks.callHook("open", peer);
      // eslint-disable-next-line unicorn/no-null
      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: res?.headers,
      });
    },
    handleDurableMessage: async (obj, ws, message) => {
      const peer = CloudflareDurablePeer._restore(obj, ws as CF.WebSocket);
      await hooks.callAdapterHook("cloudflare:message", peer, message);
      await hooks.callHook("message", peer, new Message(message, peer));
    },
    handleDurableClose: async (obj, ws, code, reason, wasClean) => {
      const peer = CloudflareDurablePeer._restore(obj, ws as CF.WebSocket);
      peers.delete(peer);
      const details = { code, reason, wasClean };
      await hooks.callAdapterHook("cloudflare:close", peer, details);
      await hooks.callHook("close", peer, details);
    },
  };
});

// --- peer ---

class CloudflareDurablePeer extends Peer<{
  ws: AugmentedWebSocket;
  request?: Partial<Request>;
  peers?: never;
  durable: DurableObjectPub;
}> {
  get peers() {
    return new Set(
      this.#getwebsockets().map((ws) =>
        CloudflareDurablePeer._restore(this._internal.durable, ws),
      ),
    );
  }

  #getwebsockets() {
    return this._internal.durable.ctx.getWebSockets() as unknown as (typeof this._internal.ws)[];
  }

  send(data: unknown) {
    return this._internal.ws.send(toBufferLike(data));
  }

  subscribe(topic: string): void {
    super.subscribe(topic);
    const state = getAttachedState(this._internal.ws);
    if (!state.t) {
      state.t = new Set();
    }
    state.t.add(topic);
    setAttachedState(this._internal.ws, state);
  }

  publish(topic: string, data: unknown): void {
    const websockets = this.#getwebsockets();
    if (websockets.length < 2 /* 1 is self! */) {
      return;
    }
    const dataBuff = toBufferLike(data);
    for (const ws of websockets) {
      if (ws === this._internal.ws) {
        continue;
      }
      const state = getAttachedState(ws);
      if (state.t?.has(topic)) {
        ws.send(dataBuff);
      }
    }
  }

  close(code?: number, reason?: string) {
    this._internal.ws.close(code, reason);
  }

  static _restore(
    durable: DurableObject,
    ws: AugmentedWebSocket,
    request?: Request | CF.Request,
  ): CloudflareDurablePeer {
    let peer = ws._crosswsPeer;
    if (peer) {
      return peer;
    }
    const state = (ws.deserializeAttachment() || {}) as AttachedState;
    peer = ws._crosswsPeer = new CloudflareDurablePeer({
      ws: ws as CF.WebSocket,
      request: (request as Request) || { url: state.u },
      durable: durable as DurableObjectPub,
    });
    if (state.i) {
      peer._id = state.i;
    }
    if (request?.url) {
      state.u = request.url;
    }
    state.i = peer.id;
    setAttachedState(ws, state);
    return peer;
  }
}

// -- attached state utils ---

function getAttachedState(ws: AugmentedWebSocket): AttachedState {
  let state = ws._crosswsState;
  if (state) {
    return state;
  }
  state = (ws.deserializeAttachment() as AttachedState) || {};
  ws._crosswsState = state;
  return state;
}

function setAttachedState(ws: AugmentedWebSocket, state: AttachedState) {
  ws._crosswsState = state;
  ws.serializeAttachment(state);
}

// --- types ---

declare class DurableObjectPub extends DurableObject {
  public ctx: DurableObject["ctx"];
  public env: unknown;
}

type AugmentedWebSocket = CF.WebSocket & {
  _crosswsPeer?: CloudflareDurablePeer;
  _crosswsState?: AttachedState;
};

/** Max serialized limit: 2048 bytes (512..2048 characters) */
type AttachedState = {
  /** Subscribed topics */
  t?: Set<string>;
  /** Peer id */
  i?: string;
  /** Request url */
  u?: string;
};

export interface CloudflareDurableAdapter extends AdapterInstance {
  handleUpgrade(
    req: Request | CF.Request,
    env: unknown,
    context: CF.ExecutionContext,
  ): Promise<Response>;

  handleDurableInit(
    obj: DurableObject,
    state: DurableObjectState,
    env: unknown,
  ): void;

  handleDurableUpgrade(
    obj: DurableObject,
    req: Request | CF.Request,
  ): Promise<Response>;

  handleDurableMessage(
    obj: DurableObject,
    ws: WebSocket | CF.WebSocket | web.WebSocket,
    message: ArrayBuffer | string,
  ): Promise<void>;

  handleDurableClose(
    obj: DurableObject,
    ws: WebSocket | CF.WebSocket | web.WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void>;
}

export interface CloudflareOptions extends AdapterOptions {
  bindingName?: string;
  instanceName?: string;
}
