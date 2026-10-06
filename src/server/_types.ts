import type { Server, ServerPlugin, ServerOptions, ServerRequest } from "srvx";

import type { Hooks, MaybePromise } from "../hooks";

import type { BunOptions, CloudflareOptions, DenoOptions } from "../adapters/_options";
import type { BunnyOptions } from "../adapters/bunny";
import type { NodeOptions } from "../adapters/node";
import type { SSEOptions } from "../adapters/sse";
import type { HeadersInit } from "../../types/web.ts";

export type WSOptions = Partial<Hooks> & {
  /**
   * Resolve the WebSocket hooks for an incoming request.
   *
   * When omitted, hooks are resolved by calling the server's `fetch` handler
   * and reading them back from either the request (the
   * `Symbol.for("crossws.hooks")` property, see `setWebSocketHooks`) or the
   * `crossws` property of the returned `Response`. Provide `resolve` only to
   * customize routing (e.g. resolve hooks without invoking the app) — a
   * user-supplied `resolve` bypasses both channels. The default is skipped when
   * inline hooks are passed directly (e.g. `ws({ message })`), which run with
   * zero per-event overhead instead.
   */
  resolve?: (req: ServerRequest) => Partial<Hooks> | Promise<Partial<Hooks>>;
  options?: {
    bun?: BunOptions;
    bunny?: BunnyOptions;
    deno?: DenoOptions;
    node?: NodeOptions;
    sse?: SSEOptions;
    cloudflare?: CloudflareOptions;
  };
};

/**
 * Value the app `fetch` handler may return for a WebSocket upgrade request when
 * the default resolver is used. Either:
 * - a `Response` carrying hooks on its `crossws` property (the srvx convention),
 *   or
 * - a plain `{ crossws, headers }` object with the hooks and optional headers to
 *   send on the WebSocket handshake response.
 *
 * Returning a normal `Response` (no `crossws`) is always valid — the connection
 * simply upgrades without hooks, unless the app attached them to the *request*
 * instead (`setWebSocketHooks`), which is the rebuild-proof channel.
 */
export type WSUpgradeResult =
  | (Response & { crossws?: Partial<Hooks> })
  | { crossws?: Partial<Hooks>; headers?: HeadersInit };

export type ServerWithWSOptions = Omit<ServerOptions, "fetch"> & {
  fetch: (request: ServerRequest) => MaybePromise<WSUpgradeResult>;
  websocket?: WSOptions;
};

export declare function plugin(options: WSOptions): ServerPlugin;

export declare function serve(options: ServerWithWSOptions): Server;
