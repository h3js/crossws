import type { Hooks } from "./hooks.ts";
import type { Peer } from "./peer.ts";

// 1 MiB — generous enough for typical chatty clients while bounding memory
// consumption of stalled-upstream peers.
const DEFAULT_MAX_BUFFER_SIZE = 1024 * 1024;

// 10 seconds — aligns with common reverse-proxy defaults (nginx, haproxy).
const DEFAULT_CONNECT_TIMEOUT = 10_000;

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
    typeof target === "string" ||
    target instanceof URL ||
    typeof target === "function"
      ? { target }
      : target;

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
      return { headers: { "sec-websocket-protocol": accepted } };
    },

    open(peer) {
      const url = _resolveTarget(options.target, peer);
      const protocols = _resolveProtocols(peer, options.forwardProtocol);

      const ws = new WebSocket(url, protocols);
      ws.binaryType = "arraybuffer";

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
        _safeClose(peer, _remapCloseCode(event.code), event.reason);
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
      const data =
        typeof message.rawData === "string"
          ? message.rawData
          : message.uint8Array();
      if (state.open) {
        state.ws.send(data);
        return;
      }
      const size = typeof data === "string" ? data.length : data.byteLength;
      const limit = options.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
      if (limit > 0 && state.bufferSize + size > limit) {
        _cleanupState(upstreams, peer.id, state);
        _safeClose(peer, 1009, "Proxy buffer limit exceeded");
        return;
      }
      state.buffer.push(data);
      state.bufferSize += size;
    },

    close(peer, details) {
      const state = upstreams.get(peer.id);
      if (!state) return;
      _clearTimeout(state);
      upstreams.delete(peer.id);
      try {
        state.ws.close(
          _remapCloseCode(details.code),
          _truncateReason(details.reason),
        );
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

function _resolveTarget(
  target: WebSocketProxyOptions["target"],
  peer: Peer,
): URL {
  const raw = typeof target === "function" ? target(peer) : target;
  return raw instanceof URL ? raw : new URL(raw);
}

function _resolveProtocols(
  peer: Peer,
  forwardProtocol: boolean | undefined,
): string[] | undefined {
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
  return new TextDecoder("utf-8", { fatal: false }).decode(
    bytes.subarray(0, 123),
  );
}

// Reserved codes must never appear in an outbound close frame.
// 1005 (no status), 1006 (abnormal), 1015 (TLS failure) get remapped.
function _remapCloseCode(code?: number): number | undefined {
  if (code === undefined) return undefined;
  if (code === 1005) return 1000;
  if (code === 1006 || code === 1015) return 1011;
  return code;
}
