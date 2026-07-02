// `crossws/websocket` entry for Bun.
//
// Bun's global `WebSocket` dials `ws:`, `wss:`, and `ws+unix:` natively, so the
// scheme never needs rewriting. But Bun takes its dialing options (`headers`,
// `protocols`, `tls`, …) as the constructor's *second* argument, unlike the
// WHATWG/`ws` third. So this wrapper accepts a third options object (e.g. the
// custom upgrade `headers` the proxy forwards) and relays it into Bun's
// second-argument form — plain `ws:`/`wss:` calls with no options keep the
// native positional signature and Bun's built-in `ws+unix:` support.

const _WebSocket = globalThis.WebSocket;

class BunWebSocket extends _WebSocket {
  constructor(url: string | URL, protocols?: string | string[], options?: Record<string, unknown>) {
    if (!options) {
      super(url, protocols);
      return;
    }
    // Bun merges `headers`/`protocols`/`tls`/… from a single options object.
    const opts: Record<string, unknown> = { ...options };
    if (protocols !== undefined) opts.protocols = protocols;
    super(url, opts as unknown as string[]);
  }
}

export default BunWebSocket as unknown as typeof globalThis.WebSocket;
