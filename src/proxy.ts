import type { Hooks } from "./hooks.ts";
import type { Peer } from "./peer.ts";

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

      const state: UpstreamState = { ws, buffer: [], open: false };
      upstreams.set(peer.id, state);

      ws.addEventListener("open", () => {
        state.open = true;
        for (const data of state.buffer) {
          ws.send(data as Parameters<WebSocket["send"]>[0]);
        }
        state.buffer.length = 0;
      });

      ws.addEventListener("message", (event) => {
        peer.send(event.data);
      });

      ws.addEventListener("close", (event) => {
        upstreams.delete(peer.id);
        _safeClose(peer, event.code, event.reason);
      });

      ws.addEventListener("error", () => {
        upstreams.delete(peer.id);
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
        state.ws.send(data as Parameters<WebSocket["send"]>[0]);
      } else {
        state.buffer.push(data);
      }
    },

    close(peer, details) {
      const state = upstreams.get(peer.id);
      if (!state) return;
      upstreams.delete(peer.id);
      try {
        state.ws.close(details.code, details.reason);
      } catch {
        // ignore invalid code/reason
      }
    },

    error(peer) {
      const state = upstreams.get(peer.id);
      if (!state) return;
      upstreams.delete(peer.id);
      try {
        state.ws.close();
      } catch {
        // ignore
      }
    },
  };
}

// --- internals ---

interface UpstreamState {
  ws: WebSocket;
  buffer: unknown[];
  open: boolean;
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
  return header.split(",").map((p) => p.trim()).filter(Boolean);
}

function _safeClose(peer: Peer, code?: number, reason?: string): void {
  try {
    peer.close(code, reason);
  } catch {
    // ignore
  }
}
