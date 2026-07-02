// `crossws/websocket` entry for Deno.
//
// Deno's global `WebSocket` dials `ws:`/`wss:` out of the box but rejects the
// `ws+unix://<socketPath>:<pathname>` scheme. This wrapper adds transparent
// Unix-socket support: such URLs are rewritten to a plain `ws://` target and the
// transport is routed through `Deno.createHttpClient`'s unstable unix `client`
// (passed via Deno's second-argument options object). All other URLs — and the
// subprotocols argument — pass through unchanged.

const _WebSocket = globalThis.WebSocket;

class DenoWebSocket extends _WebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    const href = typeof url === "string" ? url : url.href;
    if (!href.startsWith("ws+unix:")) {
      super(url, protocols);
      return;
    }
    const { socketPath, path } = _parseUnixTarget(href);
    // `transport: "unix"` is an unstable option — run Deno with `--unstable-net`.
    const client = Deno.createHttpClient({
      proxy: { transport: "unix", path: socketPath },
    } as unknown as Deno.CreateHttpClientOptions);
    // Deno's `WebSocket` takes its options (including `client` and `protocols`)
    // as the second argument, not the WHATWG/`ws` third.
    const opts: Record<string, unknown> = { client };
    if (protocols !== undefined) opts.protocols = protocols;
    super(`ws://localhost${path}`, opts as unknown as string[]);
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
