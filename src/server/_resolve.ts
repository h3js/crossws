import type { Server } from "srvx";

import { getWebSocketHooks } from "../hooks";
import { warnOnce } from "../utils";
import type { Hooks } from "../hooks";
import type { WSOptions } from "./_types";
import type { HeadersInit } from "../../types/web.ts";

const HOOK_NAMES = [
  "upgrade",
  "message",
  "open",
  "close",
  "drain",
  "error",
  "ping",
  "pong",
] as const;

// Compile-time guard: if a hook is added to `Hooks` but not listed above, the
// leftover key is no longer `never`, so this type resolves to a tuple and the
// `satisfies true` below errors — preventing the inline-hook detection in
// `defaultResolve` from silently missing the new hook.
type _AllHookNamesListed = [Exclude<keyof Hooks, (typeof HOOK_NAMES)[number]>] extends [never]
  ? true
  : ["HOOK_NAMES is missing hook(s):", Exclude<keyof Hooks, (typeof HOOK_NAMES)[number]>];
true satisfies _AllHookNamesListed;

/**
 * Resolve the hooks resolver for a server plugin.
 *
 * - When the user provides an explicit `resolve`, it is returned unchanged.
 * - When the user passes inline hook functions (e.g. `ws({ message })`) and no
 *   `resolve`, `undefined` is returned so those hooks run via the adapter's
 *   global-hook path with zero per-event overhead. Inline hooks and
 *   app-resolved hooks are treated as mutually exclusive modes.
 * - Otherwise a default resolver is returned that calls the server's own
 *   `fetch` handler and reads the hooks back from either channel: the
 *   `Symbol.for("crossws.hooks")` property the app attached to the **request**
 *   (see {@link getWebSocketHooks}), or the `crossws` property on the returned
 *   `Response` (the srvx convention). The request channel exists because a
 *   `Response` is routinely rebuilt on its way out of an app, which drops the
 *   hooks; see {@link kWebSocketHooks}.
 *
 * @throws if the server has no `fetch` handler to resolve hooks from.
 */
export function defaultResolve(server: Server, wsOpts: WSOptions): WSOptions["resolve"] {
  if (wsOpts.resolve) {
    return wsOpts.resolve;
  }

  // Inline hooks are handled by the adapter's global-hook path; adding the
  // default resolver would only cost an extra fetch per hook event.
  if (HOOK_NAMES.some((name) => typeof wsOpts[name] === "function")) {
    return undefined;
  }

  const fetch = server.options.fetch;
  if (typeof fetch !== "function") {
    throw new Error("[crossws] server has no fetch handler to resolve WebSocket hooks from");
  }

  return (req) =>
    Promise.resolve(fetch(req)).then(
      // Read the request channel *after* the fetch: the app registers its hooks
      // while handling the upgrade request. `req` is the very object handed to
      // `fetch` above, so the identity always matches.
      (res) => hooksFromFetchResult(res, getWebSocketHooks(req)) as Partial<Hooks>,
    );
}

/**
 * Extract WebSocket hooks from a `fetch` result for the default resolver.
 *
 * The result may be either:
 * - a `Response` carrying hooks on its `crossws` property — only `.crossws` is
 *   read, the body is released, and the response's HTTP headers are ignored
 *   (they are not handshake headers); or
 * - a plain `{ crossws, headers }` object, where `headers` are applied to the
 *   WebSocket handshake response.
 *
 * `reqHooks` are the hooks the app attached to the *request* instead (see
 * {@link kWebSocketHooks}). They are strictly a **recovery** channel: hooks on
 * the result always win, and a result that would have rejected the handshake
 * still rejects it. The single exception is `426 Upgrade Required` — the status
 * a framework returns *because* it routed to a WebSocket handler (h3's
 * `defineWebSocketHandler`), so a `426` alongside request hooks is an upgrade,
 * not a rejection. Any other error/redirect status still aborts, keeping
 * auth-style rejections that run after the handler intact.
 */
function hooksFromFetchResult(res: unknown, reqHooks?: Partial<Hooks>): Partial<Hooks> | undefined {
  const crossws = (res as { crossws?: Partial<Hooks> } | undefined)?.crossws;

  if (res instanceof Response) {
    if (crossws) {
      // Hooks attached — upgrade with them; the response body is unused, so
      // release it (avoids leaking a streaming/proxied body per connection).
      res.body?.cancel().catch(() => {});
      return crossws;
    }
    // No hooks on the response. Render an error/redirect response (send it to
    // the client and fail the handshake) instead of silently upgrading a
    // handler-less socket — e.g. an app returning
    // `new Response("Unauthorized", { status: 401 })` on the upgrade path.
    // `101` (Switching Protocols, as produced by e.g. Cloudflare's
    // `WebSocketPair`) signals an upgrade, so it is not treated as an error, and
    // neither is a `426` that came with hooks registered on the request.
    if (!res.ok && res.status !== 101 && !(res.status === 426 && reqHooks)) {
      if (res.status === 426) {
        // A `426` on the upgrade path means the app *did* route to a WebSocket
        // handler but its hooks never reached us — they were attached to a
        // response that some layer rebuilt. Without this the only symptom is an
        // opaque "Unexpected server response: 426" on the client. Warn once:
        // this is a per-connection path any client can hit at will.
        warnOnce(
          "[crossws] Received a 426 response with no WebSocket hooks attached. The app routed to a WebSocket handler but its hooks were lost in transit (a middleware likely rebuilt the response). Attach them to the request with `setWebSocketHooks(request, hooks)` instead, or upgrade the framework to a version that does.",
        );
      }
      return { upgrade: () => res };
    }
    // A `2xx`/`101`/rescued `426` response: proceed with the upgrade, using the
    // request-channel hooks if the app registered any (otherwise none at all);
    // the response body is unused, so release it.
    res.body?.cancel().catch(() => {});
    return reqHooks;
  }

  const headers = (res as { headers?: HeadersInit } | undefined)?.headers;
  if (!headers) {
    return crossws ?? reqHooks;
  }

  // Apply the shortcut `headers` to the handshake by composing an `upgrade`
  // hook, merged with (and overridden by) any `upgrade` hook from the resolved
  // hooks.
  const hooks = crossws ?? reqHooks;
  const userUpgrade = hooks?.upgrade;
  return {
    ...hooks,
    async upgrade(request) {
      const result = await userUpgrade?.(request);
      if (result instanceof Response) {
        return result;
      }
      return { ...result, headers: mergeHeaders(headers, result?.headers) };
    },
  };
}

function mergeHeaders(base: HeadersInit, extra?: HeadersInit): HeadersInit {
  if (!extra) {
    return base;
  }
  const merged = new Headers(base);
  for (const [key, value] of new Headers(extra)) {
    merged.set(key, value);
  }
  return merged;
}
