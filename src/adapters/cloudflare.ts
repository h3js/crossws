import type * as CF from "@cloudflare/workers-types";
import type { DurableObject } from "cloudflare:workers";
import type { AdapterOptions, AdapterInstance, Adapter } from "../adapter.ts";
import type * as web from "../../types/web.ts";
import { env as cfGlobalEnv } from "cloudflare:workers";
import { toBufferLike } from "../utils.ts";
import { AdapterHookable } from "../hooks.ts";
import { Message } from "../message.ts";
import { Peer, type PeerContext } from "../peer.ts";
import { StubRequest } from "../_request.ts";
import { WSError } from "../error.ts";

type WSDurableObjectStub = CF.DurableObjectStub & {
  webSocketPublish?: (topic: string, data: unknown, opts: any) => Promise<void>;
};

type ResolveDurableStub = (
  req: CF.Request | undefined,
  env: unknown,
  context: CF.ExecutionContext | undefined,
  namespace?: string,
) => WSDurableObjectStub | undefined | Promise<WSDurableObjectStub | undefined>;

export interface CloudflareOptions extends AdapterOptions {
  /**
   * Durable Object binding name from environment.
   *
   * **Note:** This option will be ignored if `resolveDurableStub` is provided.
   *
   * @default "$DurableObject"
   */
  bindingName?: string;

  /**
   * Durable Object instance name.
   *
   * **Note:** This option will be ignored if `resolveDurableStub` is provided.
   *
   * @default "crossws"
   */
  instanceName?: string;

  /**
   * Create durable object for each namespace.
   *
   * **Note:** This option will be ignored if `resolveDurableStub` is provided.
   *
   * **Note:** This option will cause the upgrade hook to run twice!.
   *
   * @default false
   */
  useNamespaceAsId?: boolean;

  /**
   * Custom function that resolves Durable Object binding to handle the WebSocket upgrade.
   *
   * **Note:** This option will override `bindingName`, `instanceName` and `useNamespaceAsId`.
   */
  resolveDurableStub?: ResolveDurableStub;
}

// https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/

const cloudflareAdapter: Adapter<
  CloudflareDurableAdapter,
  CloudflareOptions
> = (opts = {}) => {
  const hooks = new AdapterHookable(opts);
  const globalPeers = new Map<
    string,
    Set<CloudflareDurablePeer | CloudflareFallbackPeer>
  >();

  const defaultDurableStubResolver: ResolveDurableStub = async (
    req,
    env: any,
    _context,
    explicitNamespace,
  ) => {
    const bindingName = opts.bindingName || "$DurableObject";
    const binding = (env || cfGlobalEnv)[
      bindingName
    ] as CF.DurableObjectNamespace;

    if (!binding) {
      return undefined;
    }

    // Determine the ID name logic:
    // 1. Use explicitNamespace if provided (e.g. from publish(..., { namespace }))
    // 2. If useNamespaceAsId is true and we have a request, run the upgrade hook
    // 3. Fallback to instanceName
    let instanceName = explicitNamespace || opts.instanceName || "crossws";

    if (!explicitNamespace && opts.useNamespaceAsId && req) {
      const { namespace } = await hooks.upgrade(req as unknown as Request, {
        cf: { runtime: "worker" },
      });
      if (namespace) {
        instanceName = namespace;
      }
    }

    return binding.get(binding.idFromName(instanceName));
  };

  const resolveDurableStub: ResolveDurableStub =
    opts.resolveDurableStub || defaultDurableStubResolver;

  return {
    // Returns an empty Map(). Accessing this object across different requests or Durable Objects on Cloudflare triggers I/O errors,
    // rendering it non-functional in those contexts. Maintained solely for backward compatibility.
    peers: new Map(),
    handleUpgrade: async (request, cfEnv, cfCtx) => {
      // Upgrade request with Durable Object binding
      const stub = await resolveDurableStub(
        request as CF.Request,
        cfEnv,
        cfCtx,
      );
      if (stub) {
        return stub.fetch(
          request as CF.Request,
        ) as unknown as Promise<Response>;
      }

      // [Fallback] Upgrade request in same Worker
      const { upgradeHeaders, endResponse, context, namespace } =
        await hooks.upgrade(request as unknown as Request, {
          cf: { runtime: "worker" },
        });
      if (endResponse) {
        return endResponse as unknown as Response;
      }

      const pair = new WebSocketPair() as unknown as [
        CF.WebSocket,
        CF.WebSocket,
      ];
      const client = pair[0];
      const server = pair[1];
      const peer = new CloudflareFallbackPeer({
        ws: client,
        wsServer: server,
        request: request as unknown as Request,
        cfEnv,
        cfCtx,
        context,
        namespace,
      });
      server.accept();
      hooks.callHook("open", peer);
      server.addEventListener("message", (event) => {
        hooks.callHook(
          "message",
          peer,
          new Message(event.data, peer, event as unknown as MessageEvent),
        );
      });
      server.addEventListener("error", (event) => {
        hooks.callHook("error", peer, new WSError(event.error));
      });
      server.addEventListener("close", (event) => {
        hooks.callHook("close", peer, event);
        server.close();
      });

      return new Response(null, {
        status: 101,
        webSocket: client as unknown as WebSocket,
        headers: upgradeHeaders,
      }) as unknown as Response;
    },
    handleDurableInit: async (obj, state, env) => {
      // placeholder
    },
    handleDurableUpgrade: async (obj, request) => {
      const { upgradeHeaders, endResponse, namespace } = await hooks.upgrade(
        request as Request,
        { cf: { runtime: "DO" } },
      );
      if (endResponse) {
        return endResponse;
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      const peer = CloudflareDurablePeer._restore(
        obj,
        server as unknown as CF.WebSocket,
        request,
        namespace,
      );

      (obj as DurableObjectPub).ctx.acceptWebSocket(server);
      await hooks.callHook("open", peer);

      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: upgradeHeaders,
      });
    },
    handleDurableMessage: async (obj, ws, message) => {
      const peer = CloudflareDurablePeer._restore(obj, ws as CF.WebSocket);
      await hooks.callHook("message", peer, new Message(message, peer));
    },
    handleDurableClose: async (obj, ws, code, reason, wasClean) => {
      const peer = CloudflareDurablePeer._restore(obj, ws as CF.WebSocket);
      const details = { code, reason, wasClean };
      await hooks.callHook("close", peer, details);
    },
    handleDurablePublish: async (_obj, topic, data, opts) => {
      const peers = getDurablePeers(_obj as DurableObjectPub, topic);
      for (const peer of peers) {
        // single Durable Object with multiple namespaces
        if (peer.namespace !== opts.namespace) {
          continue;
        }
        peer.send(data);
      }
    },
    publish: async (topic, data, opts) => {
      const stub = await resolveDurableStub(
        undefined,
        cfGlobalEnv,
        undefined,
        opts?.namespace,
      );

      if (!stub) {
        throw new Error("[crossws] Durable Object binding cannot be resolved.");
      }
      // - Compatibility date >= 2024-04-03 or "rpc" feature flag is required
      // - We cannot check if webSocketPublish is exposed or not without RPC call
      try {
        return await stub.webSocketPublish!(topic, data, opts);
      } catch (error) {
        console.error(error);
        throw error;
      }
    },
  };
};

export default cloudflareAdapter;

// --- peer ---

function getDurablePeers(
  obj: DurableObjectPub,
  topic?: string,
): CloudflareDurablePeer[] {
  const peers: CloudflareDurablePeer[] = [];

  const websockets = obj.ctx.getWebSockets() as unknown as AugmentedWebSocket[];
  for (const ws of websockets) {
    const state = getAttachedState(ws);
    if (topic && state.t && !state.t.has(topic)) {
      continue;
    }

    const peer = CloudflareDurablePeer._restore(obj, ws);
    peers.push(peer);
  }
  return peers;
}

class CloudflareDurablePeer extends Peer<{
  ws: AugmentedWebSocket;
  request: Request;
  peers?: never;
  durable: DurableObjectPub;
  namespace: string;
}> {
  override get peers() {
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

  override subscribe(topic: string): void {
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
      const state = getAttachedState(ws);
      if (state.i === this.id) {
        continue;
      }
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
    namespace?: string,
  ): CloudflareDurablePeer {
    let peer = ws._crosswsPeer;
    if (peer) {
      return peer;
    }
    const state = (ws.deserializeAttachment() || {}) as AttachedState;
    const peerNamespace =
      namespace || state.n || ""; /* later throws error if empty */
    peer = ws._crosswsPeer = new CloudflareDurablePeer({
      ws: ws as CF.WebSocket,
      request:
        (request as Request | undefined) || new StubRequest(state.u || ""),
      namespace: peerNamespace,
      durable: durable as DurableObjectPub,
    });
    if (state.i) {
      peer._id = state.i;
    }
    if (request?.url) {
      state.u = request.url;
    }
    state.i = peer.id;

    state.n = peerNamespace;

    setAttachedState(ws, state);
    return peer;
  }
}

class CloudflareFallbackPeer extends Peer<{
  ws: CF.WebSocket;
  request: Request;
  wsServer: CF.WebSocket;
  cfEnv: unknown;
  cfCtx: CF.ExecutionContext;
  context: PeerContext;
  namespace: string;
}> {
  send(data: unknown) {
    this._internal.wsServer.send(toBufferLike(data));
    return 0;
  }

  publish(_topic: string, _message: any): void {
    console.warn(
      "[crossws] [cloudflare] pub/sub support requires Durable Objects.",
    );
  }

  close(code?: number, reason?: string) {
    this._internal.ws.close(code, reason);
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
  public env: any;
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
  /** Connection namespace mandatory! */
  n: string;
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

  handleDurablePublish: (
    obj: DurableObject,
    topic: string,
    data: unknown,
    opts: any,
  ) => Promise<void>;

  handleDurableClose(
    obj: DurableObject,
    ws: WebSocket | CF.WebSocket | web.WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void>;
}
