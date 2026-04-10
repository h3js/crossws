import type { Hooks } from "./hooks.ts";
import type { Peer } from "./peer.ts";

// 1 MiB — generous enough for typical chatty clients while bounding memory
// consumption of stalled-upstream peers.
const DEFAULT_MAX_BUFFER_SIZE = 1024 * 1024;

// 10 seconds — aligns with common reverse-proxy defaults (nginx, haproxy).
const DEFAULT_CONNECT_TIMEOUT = 10_000;

// RFC 7230 `token` grammar — the on-wire form of a WebSocket subprotocol
// per RFC 6455 §4.1. Used to validate values we echo back in the upgrade
// response so client-controlled input can't coerce unexpected header content.
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export interface WebSocketProxyOptions {
  /**
   * Target WebSocket URL to proxy to (`ws://` or `wss://`).
   *
   * Can be a static string/URL or a function that resolves the target dynamically
   * based on the incoming {@link Peer}.
   */
  target: string | URL | ((peer: Peer) => string | URL);

  /**
   * Forward the client's `sec-websocket-protocol` header to the upstream.
   *
   * @default true
   */
  forwardProtocol?: boolean;

  /**
   * Maximum number of bytes buffered per peer while the upstream connection
   * is still opening. If exceeded, the peer is closed with code `1009`
   * (Message Too Big). Set to `0` to disable the limit.
   *
   * @default 1048576 (1 MiB)
   */
  maxBufferSize?: number;

  /**
   * Milliseconds to wait for the upstream WebSocket handshake to complete.
   * If the upstream does not open within the timeout, the peer is closed
   * with code `1011`. Set to `0` to disable the timeout.
   *
   * @default 10000
   */
  connectTimeout?: number;

  /**
   * Custom `WebSocket` constructor used to dial the upstream. Useful when
   * the runtime does not expose a global `WebSocket` (Node.js < 22) or
   * when you want to use a different client implementation (e.g. `ws`,
   * `undici`, a mock for tests).
   *
   * @default globalThis.WebSocket
   */
  WebSocket?: typeof WebSocket;

  /**
   * Extra headers to send on the upstream handshake. Can be a static
   * object or a resolver called per peer.
   *
   * Useful to forward identity from the incoming request (`cookie`,
   * `authorization`, `origin`), or to inject a shared secret the
   * upstream expects.
   *
   * > [!NOTE]
   * > The WHATWG global `WebSocket` constructor does not accept custom
   * > headers — this option is only honored by `WebSocket` constructors
   * > that take a third options argument (e.g. `ws`, `undici`). Pass
   * > one via the {@link WebSocket} option to use it.
   *
   * @example
   * ```ts
   * createWebSocketProxy({
   *   target: "wss://backend.example.com",
   *   WebSocket: WsFromNodeWs,
   *   headers: (peer) => ({
   *     cookie: peer.request.headers.get("cookie") ?? "",
   *     "x-forwarded-for": peer.remoteAddress ?? "",
   *   }),
   * });
   * ```
   */
  headers?: HeadersInit | ((peer: Peer) => HeadersInit | undefined | void);
}

/**
 * Create a set of crossws hooks that proxy incoming WebSocket connections
 * to an upstream `ws://` or `wss://` target.
 *
 * @example
 * ```ts
 * import { createWebSocketProxy } from "crossws";
 *
 * const hooks = createWebSocketProxy("wss://echo.websocket.org");
 * ```
 */
export function createWebSocketProxy(
  target: WebSocketProxyOptions["target"] | WebSocketProxyOptions,
): Partial<Hooks> {
  const options: WebSocketProxyOptions =
    typeof target === "string" || target instanceof URL || typeof target === "function"
      ? { target }
      : target;

  const WebSocketCtor = options.WebSocket ?? globalThis.WebSocket;
  if (typeof WebSocketCtor !== "function") {
    throw new TypeError(
      "createWebSocketProxy requires a `WebSocket` constructor. Pass one via the `WebSocket` option, or use a runtime that provides a global `WebSocket` (Node.js >= 22, Bun, Deno, Cloudflare Workers, browsers).",
    );
  }

  const upstreams = new Map<string, UpstreamState>();

  return {
    upgrade(request) {
      const reqProtocol = request.headers.get("sec-websocket-protocol");
      if (options.forwardProtocol === false || !reqProtocol) {
        return;
      }
      // Accept the first requested subprotocol so the upgrade handshake
      // echoes a value the client expects. Upstream must support it too.
      const accepted = reqProtocol.split(",")[0]!.trim();
      // Defense-in-depth: only echo RFC 7230 tokens. The Fetch `Headers`
      // API already rejects CRLF, but restricting to the subprotocol
      // grammar ensures no other client-controlled bytes can land in a
      // response header — even under buggy or custom header writers.
      if (!TOKEN_RE.test(accepted)) {
        return;
      }
      return { headers: { "sec-websocket-protocol": accepted } };
    },

    open(peer) {
      let ws: WebSocket;
      try {
        const url = _resolveTarget(options.target, peer);
        const protocols = _resolveProtocols(peer, options.forwardProtocol);
        const wsOptions = _resolveWsOptions(options.headers, peer);
        // The WHATWG WebSocket constructor only takes (url, protocols);
        // additional arguments are ignored. Custom clients like `ws` and
        // `undici` accept a third options object where `headers` is
        // honored — so always pass it when the user configured headers.
        ws = wsOptions
          ? new (WebSocketCtor as unknown as new (
              url: URL,
              protocols: string[] | undefined,
              opts: { headers: HeadersInit },
            ) => WebSocket)(url, protocols, wsOptions)
          : new WebSocketCtor(url, protocols);
        ws.binaryType = "arraybuffer";
      } catch {
        // Bad target URL, disallowed scheme, invalid subprotocol token,
        // or a throwing custom resolver — close the peer with a
        // generic internal-error code rather than letting the exception
        // escape the hook.
        _safeClose(peer, 1011, "Upstream setup failed");
        return;
      }

      const state: UpstreamState = {
        ws,
        buffer: [],
        bufferSize: 0,
        open: false,
        timeout: undefined,
      };
      upstreams.set(peer.id, state);

      const timeoutMs = options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT;
      if (timeoutMs > 0) {
        state.timeout = setTimeout(() => {
          if (upstreams.get(peer.id) !== state || state.open) return;
          _cleanupState(upstreams, peer.id, state);
          _safeClose(peer, 1011, "Upstream connect timeout");
        }, timeoutMs);
      }

      ws.addEventListener("open", () => {
        _clearTimeout(state);
        state.open = true;
        for (const data of state.buffer) {
          ws.send(data);
        }
        state.buffer.length = 0;
        state.bufferSize = 0;
      });

      ws.addEventListener("message", (event) => {
        _safeSend(peer, event.data);
      });

      ws.addEventListener("close", (event) => {
        // Ignore if the state was already cleaned up (e.g. proxy-initiated
        // close or buffer limit); we only propagate unsolicited upstream
        // closures to the client.
        if (upstreams.get(peer.id) !== state) return;
        _cleanupState(upstreams, peer.id, state);
        _safeClose(peer, _remapIncomingCode(event.code), event.reason);
      });

      ws.addEventListener("error", () => {
        if (upstreams.get(peer.id) !== state) return;
        _cleanupState(upstreams, peer.id, state);
        _safeClose(peer, 1011, "Upstream error");
      });
    },

    message(peer, message) {
      const state = upstreams.get(peer.id);
      if (!state) return;
      const raw = typeof message.rawData === "string" ? message.rawData : message.uint8Array();
      if (state.open) {
        try {
          state.ws.send(raw);
        } catch {
          // upstream may have transitioned to CLOSING between the check and send
        }
        return;
      }
      // Strings become UTF-8 on the wire: a UTF-16 code unit encodes to
      // at most 3 UTF-8 bytes (surrogate pairs use 4 bytes spread across
      // 2 code units, so the per-unit worst case still bounds at 3).
      // Use the upper bound to keep the check O(1) while guaranteeing
      // the buffered payload can't exceed the configured limit on the
      // wire, even for multi-byte content.
      const size = typeof raw === "string" ? raw.length * 3 : raw.byteLength;
      const limit = options.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
      if (limit > 0 && state.bufferSize + size > limit) {
        _cleanupState(upstreams, peer.id, state);
        _safeClose(peer, 1009, "Proxy buffer limit exceeded");
        return;
      }
      // Copy binary views before buffering: the adapter may own the backing
      // memory (e.g. Node's `ws` reuses Buffers in some paths) and the buffer
      // may be flushed asynchronously once the upstream is open.
      state.buffer.push(typeof raw === "string" ? raw : Uint8Array.from(raw));
      state.bufferSize += size;
    },

    close(peer, details) {
      const state = upstreams.get(peer.id);
      if (!state) return;
      _clearTimeout(state);
      upstreams.delete(peer.id);
      try {
        state.ws.close(_normalizeOutgoingCode(details.code), _truncateReason(details.reason));
      } catch {
        // ignore invalid code/reason
      }
    },

    error(peer) {
      const state = upstreams.get(peer.id);
      if (!state) return;
      _clearTimeout(state);
      upstreams.delete(peer.id);
      try {
        state.ws.close(1011, "Peer error");
      } catch {
        // ignore
      }
    },
  };
}

// --- internals ---

interface UpstreamState {
  ws: WebSocket;
  buffer: Array<string | Uint8Array>;
  bufferSize: number;
  open: boolean;
  timeout: ReturnType<typeof setTimeout> | undefined;
}

function _cleanupState(
  upstreams: Map<string, UpstreamState>,
  id: string,
  state: UpstreamState,
): void {
  _clearTimeout(state);
  upstreams.delete(id);
  try {
    state.ws.close();
  } catch {
    // ignore
  }
}

function _clearTimeout(state: UpstreamState): void {
  if (state.timeout !== undefined) {
    clearTimeout(state.timeout);
    state.timeout = undefined;
  }
}

function _resolveTarget(target: WebSocketProxyOptions["target"], peer: Peer): URL {
  const raw = typeof target === "function" ? target(peer) : target;
  return raw instanceof URL ? raw : new URL(raw);
}

function _resolveWsOptions(
  headers: WebSocketProxyOptions["headers"],
  peer: Peer,
): { headers: HeadersInit } | undefined {
  if (!headers) return;
  const resolved = typeof headers === "function" ? headers(peer) : headers;
  if (!resolved) return;
  return { headers: resolved };
}

function _resolveProtocols(peer: Peer, forwardProtocol: boolean | undefined): string[] | undefined {
  if (forwardProtocol === false) return;
  const header = peer.request?.headers.get("sec-websocket-protocol");
  if (!header) return;
  return header
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

function _safeClose(peer: Peer, code?: number, reason?: string): void {
  try {
    peer.close(code, _truncateReason(reason));
  } catch {
    // ignore
  }
}

function _safeSend(peer: Peer, data: unknown): void {
  try {
    peer.send(data);
  } catch {
    // ignore — peer may already be closed
  }
}

// WebSocket close frames cap the reason at 123 UTF-8 bytes.
function _truncateReason(reason?: string): string | undefined {
  if (!reason) return reason;
  const bytes = new TextEncoder().encode(reason);
  if (bytes.length <= 123) return reason;
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 123));
}

// Upstream close event → peer.close. Reserved pseudo-codes (1005/1006/1015)
// must never appear on the wire, so they are rewritten. Everything else is
// forwarded as-is; server-side peers can use the full 1000-4999 range.
/** @internal exported for tests */
export function _remapIncomingCode(code?: number): number | undefined {
  if (code === undefined) return undefined;
  if (code === 1005) return 1000;
  if (code === 1006 || code === 1015) return 1011;
  return code;
}

// Peer close → upstream `state.ws.close`. The upstream is a client-side
// WebSocket, and WHATWG restricts close() to 1000 or 3000-4999 — anything
// else (1001 going-away, 1008 policy, etc.) throws InvalidAccessError.
// Normalize to 1000 so we don't silently fail to close the upstream.
/** @internal exported for tests */
export function _normalizeOutgoingCode(code?: number): number | undefined {
  if (code === undefined) return undefined;
  if (code === 1000) return 1000;
  if (code >= 3000 && code <= 4999) return code;
  return 1000;
}
