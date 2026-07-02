// `crossws/websocket` entry for Deno.
//
// Deno's global `WebSocket` dials `ws:`/`wss:` out of the box but rejects the
// `ws+unix://<socketPath>:<pathname>` scheme. This wrapper adds transparent
// Unix-socket support: such URLs are rewritten to a plain `ws://` target and the
// transport is routed through `Deno.createHttpClient`'s unstable unix `client`.
//
// Deno takes its dialing options (`client`, `protocols`, …) as the constructor's
// *second* argument, unlike the WHATWG/`ws` third. So this wrapper also accepts a
// third options object (e.g. a custom `client` from the proxy) and relays it into
// Deno's second-argument form — plain `ws:`/`wss:` calls with no options keep the
// native positional signature.

const _WebSocket = globalThis.WebSocket;

class DenoWebSocket extends _WebSocket {
  constructor(url: string | URL, protocols?: string | string[], options?: Record<string, unknown>) {
    const href = typeof url === "string" ? url : url.href;
    const isUnix = href.startsWith("ws+unix:");
    if (!isUnix && !options) {
      super(url, protocols);
      return;
    }
    const opts: Record<string, unknown> = { ...options };
    if (protocols !== undefined) opts.protocols = protocols;
    if (isUnix) {
      const { socketPath, path } = _parseUnixTarget(href);
      // `transport: "unix"` is an unstable option — run Deno with `--unstable-net`.
      opts.client ??= Deno.createHttpClient({
        proxy: { transport: "unix", path: socketPath },
      } as unknown as Deno.CreateHttpClientOptions);
      super(`ws://localhost${path}`, opts as unknown as string[]);
      return;
    }
    super(url, opts as unknown as string[]);
  }
}

// Split a `ws+unix://<socketPath>:<pathname>` URL into its socket path and the
// upstream request path. The socket path is everything before the first `:` in
// the URL path; the rest (plus any query string) is the request path.
function _parseUnixTarget(href: string): { socketPath: string; path: string } {
  const { pathname, search } = new URL(href);
  const raw = pathname + search;
  const colon = raw.indexOf(":");
  if (colon === -1) {
    return { socketPath: raw, path: "/" };
  }
  return { socketPath: raw.slice(0, colon), path: raw.slice(colon + 1) || "/" };
}

export default DenoWebSocket as unknown as typeof globalThis.WebSocket;
