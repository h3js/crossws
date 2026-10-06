import type { AdapterOptions } from "./adapter.ts";
import type { WSError } from "./error.ts";
import type { Peer, PeerContext } from "./peer.ts";
import type { Message } from "./message.ts";

export class AdapterHookable {
  options: AdapterOptions;

  // Memoized `resolve` result per connection. `resolve` may be expensive — the
  // default `crossws/server` resolver invokes the app's `fetch` handler — so it
  // must run **exactly once per connection**, not on every `callHook` (i.e. not
  // on every message). The cache is keyed by the connection's `context` object,
  // which `upgrade()` creates and every adapter re-exposes verbatim as
  // `peer.context`. That single shared identity spans both the `upgrade` event
  // and every later peer event, so one `resolve` call serves the whole
  // connection. Keyed weakly so entries are released when the connection is
  // garbage collected.
  #resolveCache = new WeakMap<object, MaybePromise<Partial<Hooks> | undefined>>();

  constructor(options?: AdapterOptions) {
    this.options = options || {};
  }

  callHook<N extends keyof Hooks>(
    name: N,
    arg1: Parameters<Hooks[N]>[0],
    arg2?: Parameters<Hooks[N]>[1],
    // The connection's `context` object, used as the per-connection cache key.
    // Passed explicitly by `upgrade()` (no peer exists yet); for peer events it
    // is derived from `peer.context`, which is the same object.
    connection?: object,
  ): MaybePromise<ReturnType<Hooks[N]>> {
    // Call global hook first
    const globalHook = this.options.hooks?.[name];
    const globalPromise = globalHook?.(arg1 as any, arg2 as any);

    const resolve = this.options.resolve;
    if (!resolve) {
      return globalPromise as any; // Fast path: no resolver configured
    }

    // Resolve hooks for the connection, memoized by the shared `context`
    // identity so `resolve` runs once per connection instead of per event.
    const request = (arg1 as Peer).request || arg1;
    const cacheKey = connection || (arg1 as Peer).context || request;
    let resolveHooksPromise: MaybePromise<Partial<Hooks> | undefined>;
    if (this.#resolveCache.has(cacheKey)) {
      resolveHooksPromise = this.#resolveCache.get(cacheKey);
    } else {
      // `resolve` may throw *synchronously* (e.g. the default resolver's
      // `fetch(req)` throwing before it returns a promise). Normalize that to a
      // rejected promise so it flows through the same eviction/`.catch` path as
      // an async rejection, instead of escaping as a synchronous throw — which,
      // on the fire-and-forget event call sites (message/close/…), would surface
      // as an uncaught exception rather than a handled rejection.
      try {
        resolveHooksPromise = resolve(request);
      } catch (error) {
        resolveHooksPromise = Promise.reject(error);
      }
      this.#resolveCache.set(cacheKey, resolveHooksPromise);
      // Don't let a rejected `resolve` poison the whole connection: evict the
      // failed entry so a later event can retry and recover from a transient
      // error (e.g. the default resolver's `fetch` failing once). Guarded so a
      // concurrent re-resolve isn't clobbered. This `catch` is a separate branch
      // and does not swallow the rejection seen by the hook resolution below.
      if (resolveHooksPromise instanceof Promise) {
        resolveHooksPromise.catch(() => {
          if (this.#resolveCache.get(cacheKey) === resolveHooksPromise) {
            this.#resolveCache.delete(cacheKey);
          }
        });
      }
    }
    if (!resolveHooksPromise) {
      return globalPromise as any; // Fast path: no hooks to resolve
    }
    const resolvePromise =
      resolveHooksPromise instanceof Promise
        ? resolveHooksPromise.then((hooks) => hooks?.[name])
        : resolveHooksPromise?.[name];

    // In parallel, call global hook and resolve hook implementation
    return Promise.all([globalPromise, resolvePromise]).then(([globalRes, hook]) => {
      const hookResPromise = hook?.(arg1 as any, arg2 as any);
      return hookResPromise instanceof Promise
        ? hookResPromise.then((hookRes) => hookRes || globalRes)
        : hookResPromise || globalRes;
    }) as Promise<any>;
  }

  async upgrade(request: Request & { readonly context?: Record<string, unknown> }): Promise<{
    context: PeerContext;
    namespace: string;
    upgradeHeaders?: HeadersInit;
    endResponse?: Response;
    handled?: boolean;
    perMessageDeflate?: boolean | PerMessageDeflateOptions;
  }> {
    let namespace = this.options.getNamespace?.(request) ?? new URL(request.url).pathname;

    const context = request.context || {};

    let upgradeHeaders: HeadersInit | undefined;
    let protocolFromHook: string | undefined;
    let perMessageDeflate: boolean | PerMessageDeflateOptions | undefined;

    try {
      // Seed the per-connection resolve cache against `context` so every later
      // peer event on this connection reuses this single `resolve` call.
      const res = await this.callHook(
        "upgrade",
        request as Request & { context?: PeerContext },
        undefined,
        context,
      );
      if (res) {
        if ((res as { namespace?: string }).namespace) {
          namespace = (res as { namespace: string }).namespace;
        }
        if ((res as { context?: Record<string, unknown> }).context) {
          Object.assign(context, (res as { context?: Record<string, unknown> }).context);
        }
        if (res instanceof Response) {
          return { context, namespace, endResponse: res };
        }
        if ((res as { handled?: boolean }).handled) {
          // Hook took ownership of the socket — any `headers`/`protocol`
          // returned alongside `handled` are ignored since the adapter skips
          // its own upgrade and no response will be written from here.
          return { context, namespace, handled: true };
        }
        upgradeHeaders = res.headers;
        protocolFromHook = (res as { protocol?: string }).protocol;
        perMessageDeflate = res.perMessageDeflate;
      }
    } catch (error) {
      const errResponse = (error as { response: Response }).response || error;
      if (errResponse instanceof Response) {
        return {
          context,
          namespace,
          endResponse: errResponse,
        };
      }
      throw error;
    }

    // Resolve the negotiated subprotocol (opt-in; strict/no-echo by default).
    // Adapters don't need to know about any of this: every runtime turns a
    // `sec-websocket-protocol` entry in `upgradeHeaders` into the accepted
    // subprotocol (Node re-emits it via ws's `headers` event, Deno reads it
    // into its native `protocol` option, Bun forwards it to `server.upgrade`),
    // so folding the choice back into the headers here keeps negotiation
    // consistent across all of them from a single place.
    const protocol = await this._resolveProtocol(request, upgradeHeaders, protocolFromHook);
    if (protocol) {
      const merged = new Headers(upgradeHeaders);
      merged.set("sec-websocket-protocol", protocol);
      upgradeHeaders = merged;
    }

    return { context, namespace, upgradeHeaders, perMessageDeflate };
  }

  // Pick the subprotocol to accept, in precedence order:
  //   1. `protocol` returned explicitly from the `upgrade` hook (per-connection).
  //   2. a `sec-websocket-protocol` header set directly by the hook (the
  //      pre-existing way to negotiate, kept working verbatim).
  //   3. the `handleProtocols(protocols, request)` adapter option (global
  //      default), mirroring ws's own selector signature.
  // Returns `undefined` to accept no subprotocol — the strict default, so a
  // server never claims to speak a protocol the app didn't opt into.
  async _resolveProtocol(
    request: Request,
    upgradeHeaders: HeadersInit | undefined,
    protocolFromHook: string | undefined,
  ): Promise<string | undefined> {
    if (protocolFromHook) {
      return protocolFromHook;
    }
    if (upgradeHeaders) {
      const headers =
        upgradeHeaders instanceof Headers ? upgradeHeaders : new Headers(upgradeHeaders);
      const fromHeader = headers.get("sec-websocket-protocol");
      if (fromHeader) {
        return fromHeader;
      }
    }
    const handleProtocols = this.options.handleProtocols;
    if (handleProtocols) {
      const offered = _parseProtocols(request.headers.get("sec-websocket-protocol"));
      if (offered.size > 0) {
        const chosen = await handleProtocols(offered, request);
        if (chosen) {
          return chosen;
        }
      }
    }
    return undefined;
  }
}

// Parse a `sec-websocket-protocol` request header ("a, b , c") into the set of
// distinct, trimmed subprotocol tokens the client offered.
function _parseProtocols(header: string | null | undefined): Set<string> {
  const protocols = new Set<string>();
  if (!header) {
    return protocols;
  }
  for (const part of header.split(",")) {
    const token = part.trim();
    if (token) {
      protocols.add(token);
    }
  }
  return protocols;
}

// --- request-attached hooks ---

/**
 * Registry symbol used to hand WebSocket hooks off to crossws **on the request**.
 *
 * This symbol — the literal `Symbol.for("crossws.hooks")` key, not the helpers
 * below — is the wire format, and is public API. Frameworks that depend on
 * crossws for *types only* (h3 keeps it an optional peer dependency and has no
 * runtime import) can write it without importing anything, and because it lives
 * in the global symbol registry it also crosses duplicate module instances and
 * realms.
 *
 * The request is used rather than the response because a `Response` is routinely
 * *rebuilt* on its way out of an app — merging a staged header, stripping a HEAD
 * body, wrapping a stream, `new Response(res.body, res)` in any middleware — and
 * a rebuilt response carries none of the original's own properties, silently
 * dropping hooks attached to it. Nothing in that chain replaces the request.
 *
 * Honored only by the default resolver of the `crossws/server` plugin; a
 * user-supplied `resolve` bypasses it entirely.
 */
export const kWebSocketHooks: unique symbol = Symbol.for("crossws.hooks");

type HooksCarrier = { [kWebSocketHooks]?: Partial<Hooks> };

/**
 * Attach WebSocket hooks to an upgrade request, for the default resolver to pick
 * up after the app's `fetch` handler returns.
 *
 * Written to the request object itself and, when the request already carries a
 * srvx-style `context` bag, into that too — frameworks that derive a new request
 * internally (e.g. mounting a sub-app under a base path) usually propagate the
 * context reference, so the hooks survive the derivation.
 *
 * The direct write is guarded: ESM is strict mode, so assigning to a
 * non-extensible request would *throw* rather than fail quietly, turning a lost
 * hooks bug into a dead upgrade. If a runtime ever hands out a frozen request,
 * the attach is a no-op and the response channel (`res.crossws`) still applies.
 */
export function setWebSocketHooks(request: Request, hooks: Partial<Hooks>): void {
  try {
    (request as HooksCarrier)[kWebSocketHooks] = hooks;
  } catch {
    // non-extensible request — fall through to the context bag / response channel
  }
  const context = (request as { context?: HooksCarrier }).context;
  if (context) {
    context[kWebSocketHooks] = hooks;
  }
}

/** Read back hooks attached with {@link setWebSocketHooks} (or the raw symbol). */
export function getWebSocketHooks(request: Request): Partial<Hooks> | undefined {
  return (
    (request as HooksCarrier)[kWebSocketHooks] ??
    (request as { context?: HooksCarrier }).context?.[kWebSocketHooks]
  );
}

// --- types ---

export function defineHooks<T extends Partial<Hooks> = Partial<Hooks>>(hooks: T): T {
  return hooks;
}

export type ResolveHooks = (
  request: Request & { readonly context?: PeerContext },
) => Partial<Hooks> | Promise<Partial<Hooks>>;

export type MaybePromise<T> = T | Promise<T>;

/**
 * `permessage-deflate` (RFC 7692) settings for a single connection. Mirrors the
 * `perMessageDeflate` server option of [`ws`](https://github.com/websockets/ws/blob/master/doc/ws.md#new-websocketserveroptions-callback),
 * which applies it on Node.js.
 */
export interface PerMessageDeflateOptions {
  /** Don't reuse the server's compression context across messages. Lowers the ratio but keeps per-connection memory flat. */
  serverNoContextTakeover?: boolean;
  /** Ask the client not to reuse its compression context across messages. */
  clientNoContextTakeover?: boolean;
  /** LZ77 window size (8–15) the server compresses with. */
  serverMaxWindowBits?: number;
  /** LZ77 window size (8–15) the client is asked to compress with. */
  clientMaxWindowBits?: number;
  /** Options for the `zlib` deflate stream (e.g. `{ level: 3 }`). */
  zlibDeflateOptions?: {
    level?: number;
    memLevel?: number;
    strategy?: number;
    chunkSize?: number;
    windowBits?: number;
  };
  /** Options for the `zlib` inflate stream. */
  zlibInflateOptions?: { chunkSize?: number; windowBits?: number };
  /** Payloads smaller than this many bytes are sent uncompressed (`ws` default: `1024`). */
  threshold?: number;
  /** Max concurrent `zlib` calls (`ws` default: `10`). */
  concurrencyLimit?: number;
}

export type UpgradeError = Response | { readonly response: Response };

export interface Hooks {
  /**
   * Upgrading a request to a WebSocket connection.
   *
   * - You can throw a Response to abort the upgrade.
   * - You can return { headers } to modify the response.
   * - You can return { protocol } to accept a WebSocket subprotocol for this
   *   connection (echoed back as `Sec-WebSocket-Protocol`). This is the
   *   per-connection counterpart to the global
   *   {@link AdapterOptions.handleProtocols} option and takes precedence over
   *   it. It should be one of the subprotocols the client offered (the values
   *   in the request's `Sec-WebSocket-Protocol` header).
   * - You can return { perMessageDeflate } to accept (`true` or an options
   *   object) or refuse (`false`) `permessage-deflate` compression for this
   *   connection, overriding the adapter's default. Only honored by the Node.js
   *   adapter; other runtimes configure compression server-wide, if at all.
   * - You can return { namespace } to change the pub/sub namespace.
   * - You can return { context } to provide a custom peer context.
   * - You can return { handled: true } to signal that the upgrade has
   *   already been performed by the hook (e.g. delegated to an external
   *   node-style `(req, socket, head)` handler). The adapter will then
   *   leave the socket alone and skip its own upgrade.
   *
   * @param request
   * @throws {Response}
   */
  upgrade: (
    request: Request & {
      readonly context?: Record<string, unknown>;
    },
  ) => MaybePromise<
    | {
        headers?: HeadersInit;
        protocol?: string;
        perMessageDeflate?: boolean | PerMessageDeflateOptions;
        namespace?: string;
        context?: PeerContext;
        handled?: boolean;
      }
    | Response
    | void
  >;

  /** A message is received */
  message: (peer: Peer, message: Message) => MaybePromise<void>;

  /** A socket is opened */
  open: (peer: Peer) => MaybePromise<void>;

  /** A socket is closed */
  close: (peer: Peer, details: { code?: number; reason?: string }) => MaybePromise<void>;

  /**
   * The send buffer has drained after backpressure, so it is safe to resume
   * sending. Pair with {@link Peer.bufferedAmount} to throttle senders.
   *
   * **Note:** Only emitted by adapters that expose a drain signal. Refer to the
   * [compatibility table](https://crossws.h3.dev/guide/peer#compatibility).
   */
  drain: (peer: Peer) => MaybePromise<void>;

  /** An error occurs */
  error: (peer: Peer, error: WSError) => MaybePromise<void>;

  /**
   * An application-level WebSocket ping control frame was received from the
   * peer (e.g. sent by the client, or by another server via
   * {@link Peer.ping}).
   *
   * **Note:** Only emitted by adapters that surface inbound ping frames.
   * Refer to the [compatibility table](https://crossws.h3.dev/guide/peer#compatibility).
   */
  ping: (peer: Peer, data: Uint8Array) => MaybePromise<void>;

  /**
   * An application-level WebSocket pong control frame was received from the
   * peer, typically in reply to {@link Peer.ping}. Use together with a
   * timestamp embedded in the ping payload to measure round-trip latency.
   *
   * **Note:** Only emitted by adapters that surface inbound pong frames.
   * Refer to the [compatibility table](https://crossws.h3.dev/guide/peer#compatibility).
   */
  pong: (peer: Peer, data: Uint8Array) => MaybePromise<void>;
}
