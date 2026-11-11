import type { AdapterOptions, AdapterInstance, Adapter } from "../adapter.ts";
import { toBufferLike } from "../utils.ts";
import { adapterUtils, getPeers, DEFAULT_IDLE_TIMEOUT } from "../adapter.ts";
import { AdapterHookable, type PerMessageDeflateOptions } from "../hooks.ts";
import { Message } from "../message.ts";
import { WSError } from "../error.ts";
import { Peer, type PeerContext } from "../peer.ts";
import type { SyncDriver } from "../sync.ts";

import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer as _WebSocketServer } from "ws";
import type { ServerOptions, WebSocketServer, WebSocket as WebSocketT } from "../../types/ws";
import { StubRequest } from "../_request.ts";
import type { HeadersInit } from "../../types/web.ts";

// --- types ---

type AugmentedReq = IncomingMessage & {
  _request?: Request;
  _upgradeHeaders?: HeadersInit;
  _context: PeerContext;
  _namespace: string;
};

// `@cloudflare/workers-types` is part of the project-wide `types` and declares
// `Buffer` as `any`. That breaks the global `Buffer` *type* (the merged
// interface loses its Node-only members such as `equals`), but not the global
// `Buffer` *value*, so recover a usable type from the constructor.
type NodeBuffer = ReturnType<typeof Buffer.concat>;

// `ws` instance tagged with the heartbeat liveness flag (see the idle sweep below).
type HeartbeatWS = WebSocketT & { _isAlive?: boolean };

// Payload carried by our own liveness probe (see the idle sweep). The client
// echoes it back in the pong, letting the `pong` handler tell an internal
// keepalive reply apart from an app-level `peer.ping()` and skip the `pong`
// hook for it. Kept well under the 125-byte control-frame limit.
const HEARTBEAT_PING = Buffer.from("crossws-ping");

export interface NodeAdapter extends AdapterInstance {
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    webRequest?: Request,
  ): Promise<void>;
  closeAll: (code?: number, data?: string | Buffer, force?: boolean) => void;
}

export interface NodeOptions extends AdapterOptions {
  wss?: WebSocketServer;
  serverOptions?: ServerOptions;
}

// --- adapter ---

// https://github.com/websockets/ws
// https://github.com/websockets/ws/blob/master/doc/ws.md
const nodeAdapter: Adapter<NodeAdapter, NodeOptions> = (options = {}) => {
  if ("Deno" in globalThis || "Bun" in globalThis) {
    throw new Error("[crossws] Using Node.js adapter in an incompatible environment.");
  }
  return _nodeAdapter(options);
};

/**
 * Node.js adapter without the runtime guard.
 *
 * Used by adapters for platforms that own the server and hand over Node.js
 * request/socket objects regardless of the underlying runtime (e.g. Vercel's
 * Bun runtime).
 *
 * @internal
 */
export const _nodeAdapter: Adapter<NodeAdapter, NodeOptions> = (options = {}) => {
  const hooks = new AdapterHookable(options);
  const globalPeers = new Map<string, Set<NodePeer>>();
  const baseUtils = adapterUtils(globalPeers, options);

  const wss: WebSocketServer =
    options.wss ||
    (new _WebSocketServer({
      noServer: true,
      handleProtocols: () => false,
      ...(options.serverOptions as any),
    }) as WebSocketServer);

  // Sockets crossws opened through this adapter. We track them ourselves rather
  // than read `wss.clients` so the idle sweep and `closeAll` (a) never touch
  // foreign connections on a shared/user-supplied `wss`, and (b) don't crash
  // when `clientTracking` is disabled — which leaves `wss.clients` `undefined`.
  const liveSockets = new Set<HeartbeatWS>();

  // `idleTimeout` is configured in seconds (consistent with the Bun/Deno/uWS
  // adapters); `ws` has no native liveness, so we emulate it with a ping sweep.
  // Defaults to 30s so half-open connections can't leak out of the box; `0`
  // opts out. The sweep runs once per `idleTimeout`: a peer is pinged at one
  // tick and, if it hasn't answered (or sent anything) by the next, terminated.
  // Giving a peer a full interval to reply means a live-but-slow connection
  // (high-latency mobile/satellite link) is never dropped, matching the native
  // runtimes, which likewise close only after a full idle window; a dead socket
  // is caught within ~1–2×`idleTimeout`.
  const idleTimeoutMs = (options.idleTimeout ?? DEFAULT_IDLE_TIMEOUT) * 1000;
  const sweepMs = Math.max(1, Math.floor(idleTimeoutMs));

  wss.on("connection", (ws, nodeReq: AugmentedReq) => {
    // Reuse the exact request the `upgrade` hook authorized (e.g. srvx's
    // `NodeRequest`), so `peer.request` keeps its URL and any app state. Fall
    // back to a proxy for sockets crossws didn't upgrade (shared `wss`).
    const request = nodeReq._request || new NodeReqProxy(nodeReq);
    const peers = getPeers(globalPeers, nodeReq._namespace);
    const peer = new NodePeer({
      ws,
      request,
      peers,
      nodeReq,
      namespace: nodeReq._namespace,
      sync: baseUtils.sync,
      hooks,
    });
    peers.add(peer);
    liveSockets.add(ws as HeartbeatWS);
    if (idleTimeoutMs > 0) {
      // Standard `ws` liveness pattern: `_isAlive` is reset to `true` on any
      // inbound traffic (pong, message, ping) and on connect, and the idle
      // sweep flips it to `false` right before pinging. A peer still `false`
      // at the next sweep saw no traffic for a whole interval and never
      // answered the probe ping, so its connection is presumed dead.
      (ws as HeartbeatWS)._isAlive = true;
      const markAlive = () => {
        (ws as HeartbeatWS)._isAlive = true;
      };
      ws.on("pong", markAlive);
      ws.on("ping", markAlive);
      ws.on("message", markAlive);
    }
    hooks.callHook("open", peer); // ws is already open
    ws.on("message", (rawData: NodeBuffer | ArrayBuffer | NodeBuffer[], isBinary: boolean) => {
      const buff = Array.isArray(rawData) ? Buffer.concat(rawData) : rawData;
      const data = !isBinary && !(buff instanceof ArrayBuffer) ? buff.toString("utf8") : buff;
      hooks.callHook("message", peer, new Message(data, peer));
    });
    // `ws` auto-replies to an inbound ping with a pong per the spec; these
    // hooks only observe the control frames, they don't need to answer them.
    ws.on("ping", (data: NodeBuffer) => {
      hooks.callHook("ping", peer, data);
    });
    ws.on("pong", (data: NodeBuffer) => {
      // Skip our own liveness probe's echoed pong (see the idle sweep); it is
      // not an app-level pong and would otherwise fire the `pong` hook every
      // idle interval with a bogus payload.
      if (data.equals(HEARTBEAT_PING)) {
        return;
      }
      hooks.callHook("pong", peer, data);
    });
    ws.on("error", (error: Error) => {
      peers.delete(peer);
      hooks.callHook("error", peer, new WSError(error));
    });
    // `ws` has no drain event of its own; the underlying TCP socket emits
    // `drain` after a backpressured write flushes. Note this tracks the OS
    // socket buffer, which is an approximation of `peer.bufferedAmount` (the
    // latter also includes ws's internal sender queue) — treat it as a resume
    // nudge, not an exact "bufferedAmount reached 0" signal.
    const socket = (ws as WebSocketT & { _socket?: Duplex })._socket;
    const onDrain = () => hooks.callHook("drain", peer);
    socket?.on("drain", onDrain);
    ws.on("close", (code: number, reason: Buffer) => {
      peers.delete(peer);
      liveSockets.delete(ws as HeartbeatWS);
      socket?.off("drain", onDrain);
      hooks.callHook("close", peer, {
        code,
        reason: reason?.toString(),
      });
    });
  });

  // Single shared idle sweep for all peers rather than a timer per connection.
  // Terminating a dead peer destroys its socket, which makes `ws` emit
  // `'close'` (code 1006) → our `close` handler → the `close` hook fires, so
  // downstream teardown (e.g. `createWebSocketProxy` closing its upstream) runs
  // through the exact same path as any other disconnect.
  let idleTimer: ReturnType<typeof setInterval> | undefined;
  const stopSweep = () => {
    if (idleTimer) {
      clearInterval(idleTimer);
      idleTimer = undefined;
    }
  };
  if (idleTimeoutMs > 0) {
    idleTimer = setInterval(() => {
      for (const ws of liveSockets) {
        if (ws._isAlive === false) {
          ws.terminate();
          continue;
        }
        ws._isAlive = false;
        try {
          ws.ping(HEARTBEAT_PING);
        } catch {
          // socket may have raced into CLOSING between the sweep and the ping
        }
      }
    }, sweepMs);
    // Don't let the sweep keep an otherwise-idle process alive.
    idleTimer.unref?.();
    // Stop sweeping once the server is gone.
    wss.on("close", stopSweep);
  }

  wss.on("headers", (outgoingHeaders, req) => {
    const upgradeHeaders = (req as AugmentedReq)._upgradeHeaders;
    if (upgradeHeaders) {
      for (const [key, value] of new Headers(upgradeHeaders)) {
        outgoingHeaders.push(`${key}: ${value}`);
      }
    }
  });

  return {
    ...baseUtils,
    close: async (code, reason) => {
      stopSweep();
      await baseUtils.close(code, reason);
    },
    handleUpgrade: async (nodeReq, socket, head, webRequest) => {
      // Node removes its own `error` listener before emitting `upgrade`, and
      // `ws` only adds one once the handshake is handed to it. Until then, a
      // client reset (e.g. during an async `upgrade` hook, or while writing a
      // rejection) would be an unhandled `error` event and crash the process.
      socket.on("error", () => socket.destroy());

      const request = webRequest || new NodeReqProxy(nodeReq);

      let upgraded: Awaited<ReturnType<typeof hooks.upgrade>>;
      try {
        upgraded = await hooks.upgrade(request);
      } catch (error) {
        // `handleUpgrade` is invoked fire-and-forget from the server's
        // `upgrade` listener, so a rejected `upgrade()` (e.g. the default
        // resolver's app `fetch` throwing) would otherwise hang the socket and
        // raise an unhandled rejection. Fail the handshake with a 500 instead.
        console.error("[crossws] [node] `upgrade` hook failed:", error);
        // A hook may have taken over the socket before throwing (e.g. a
        // `fromNodeUpgradeHandler` handler that completed the handshake), so
        // never write a response into a stream that is no longer ours.
        if (socket.destroyed || (socket as Socket).bytesWritten > 0) {
          return;
        }
        return sendResponse(socket, new Response("Internal Server Error", { status: 500 }));
      }
      const { upgradeHeaders, endResponse, handled, context, namespace, perMessageDeflate } =
        upgraded;
      if (endResponse) {
        return sendResponse(socket, endResponse);
      }
      // Upgrade was performed by the hook (e.g. delegated to an external
      // node-style handler via `fromNodeUpgradeHandler`). The socket has
      // been taken over — leave it alone.
      if (handled) {
        return;
      }

      (nodeReq as AugmentedReq)._request = request;
      (nodeReq as AugmentedReq)._upgradeHeaders = upgradeHeaders;
      (nodeReq as AugmentedReq)._context = context;
      (nodeReq as AugmentedReq)._namespace = namespace;
      handleUpgradeWithDeflate(wss, perMessageDeflate, nodeReq, socket, head, (ws) => {
        wss.emit("connection", ws, nodeReq);
      });
    },
    closeAll: (code, data, force) => {
      for (const ws of liveSockets) {
        if (force) {
          ws.terminate();
        } else {
          ws.close(code, data);
        }
      }
    },
  };
};

export default nodeAdapter;

export { fromNodeUpgradeHandler } from "../node-handler.ts";
export type { NodeUpgradeHandler } from "../node-handler.ts";

// `ws` negotiates `permessage-deflate` from its server-wide `options`, so a
// per-connection setting (`perMessageDeflate` returned by the `upgrade` hook) is
// applied by overriding that option for the duration of `handleUpgrade`. `ws`
// reads it only synchronously there — the negotiated extension is built before
// `verifyClient`/`completeUpgrade` run — so the override never leaks into another
// handshake, while everything else (`verifyClient`, `maxPayload`, `clients`,
// `headers` listeners, close state) stays that of the one shared server.
function handleUpgradeWithDeflate(
  wss: WebSocketServer,
  perMessageDeflate: boolean | PerMessageDeflateOptions | undefined,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  cb: (ws: WebSocketT) => void,
): void {
  const serverOptions = wss.options;
  const original = serverOptions.perMessageDeflate;
  // `true` enables the extension with the server's own tuning, if any.
  let override: ServerOptions["perMessageDeflate"] =
    perMessageDeflate === true ? original || {} : perMessageDeflate;
  // `ws` sizes its process-wide zlib limiter from whichever deflate instance is
  // created first, so keep the server's `concurrencyLimit` on per-connection
  // options too; otherwise a hook-configured handshake could fix it at the default.
  const concurrencyLimit = typeof original === "object" ? original.concurrencyLimit : undefined;
  if (typeof override === "object" && override !== original && concurrencyLimit !== undefined) {
    override = { ...override, concurrencyLimit };
  }
  if (override === undefined || override === original) {
    wss.handleUpgrade(req, socket, head, cb);
    return;
  }
  serverOptions.perMessageDeflate = override;
  try {
    wss.handleUpgrade(req, socket, head, cb);
  } finally {
    serverOptions.perMessageDeflate = original;
  }
}

// --- peer ---

class NodePeer extends Peer<{
  peers: Set<NodePeer>;
  request: Request;
  namespace: string;
  nodeReq: IncomingMessage;
  ws: WebSocketT & { _peer?: NodePeer };
  sync?: SyncDriver;
  hooks: AdapterHookable;
}> {
  override get remoteAddress() {
    return this._internal.nodeReq.socket?.remoteAddress;
  }

  override get context() {
    return (this._internal.nodeReq as AugmentedReq)._context;
  }

  send(data: unknown, options?: { compress?: boolean }) {
    const dataBuff = toBufferLike(data);
    const isBinary = typeof dataBuff !== "string";
    this._internal.ws.send(dataBuff, {
      binary: isBinary,
      ...options,
      // `ws` compresses by default once `permessage-deflate` is negotiated (its
      // `threshold` only applies without server context takeover); an explicit
      // `undefined` would disable that.
      compress: options?.compress ?? true,
    });
    return this._internal.ws.bufferedAmount;
  }

  _publish(topic: string, data: unknown, options?: { compress?: boolean }): void {
    const dataBuff = toBufferLike(data);
    // Derive `isBinary` from the serialized buffer, not the raw input: a plain
    // object/number is normalized to a JSON/text string by `toBufferLike`, so it
    // must be sent as text. (Matches the uWS adapter's handling.)
    const isBinary = typeof dataBuff !== "string";
    const sendOptions = {
      binary: isBinary,
      ...options,
      compress: options?.compress ?? true,
    };
    for (const peer of this._internal.peers) {
      if (peer !== this && peer._topics.has(topic)) {
        peer._internal.ws.send(dataBuff, sendOptions);
      }
    }
  }

  close(code?: number, data?: string | Buffer) {
    this._internal.ws.close(code, data);
  }

  override terminate() {
    this._internal.ws.terminate();
  }

  override ping(data?: unknown): void {
    // `ws` validates the control frame synchronously (rejecting non-buffer
    // payloads and anything over the 125-byte limit) and throws. Surface that
    // through the `error` hook instead of letting it crash the process — e.g.
    // when `ping()` is called from inside a hook handler.
    try {
      this._internal.ws.ping(data);
    } catch (error) {
      this._internal.hooks.callHook("error", this, new WSError(error));
    }
  }
}

// --- web compat ---

class NodeReqProxy extends StubRequest {
  constructor(req: IncomingMessage) {
    const host = req.headers["host"] || "localhost";
    const isSecure = (req.socket as any)?.encrypted ?? req.headers["x-forwarded-proto"] === "https";
    const url = `${isSecure ? "https" : "http"}://${host}${req.url}`;
    super(url, { headers: req.headers as Record<string, string> });
  }
}

// Node's HTTP server timeouts no longer apply once a request is handed to the
// `upgrade` listener, so bound how long a client that stops reading can hold a
// rejection's socket.
const REJECTION_IDLE_TIMEOUT = 30_000;

// Writes `res` to the raw upgrade socket and closes it. Never rejects: callers
// invoke `handleUpgrade` fire-and-forget, so errors are logged and the socket
// is destroyed instead.
async function sendResponse(socket: Duplex, res: Response): Promise<void> {
  let encoded: ReturnType<typeof encodeResponse>;
  try {
    encoded = encodeResponse(res);
  } catch (error) {
    console.error("[crossws] [node] Invalid upgrade rejection response:", error);
    encoded = encodeResponse(new Response("Internal Server Error", { status: 500 }));
  }
  const { head, reader } = encoded;

  (socket as Socket).setTimeout?.(REJECTION_IDLE_TIMEOUT, () => socket.destroy());
  // Header values and the reason phrase are ByteStrings (latin1), as written by
  // Node's own `ServerResponse`.
  socket.write(head, "latin1");

  if (reader) {
    // Cancelling settles a pending `read()`, so the source is stopped even when
    // the socket closes (client reset, idle timeout) while waiting on a slow or
    // stalled body.
    const onClose = () => reader.cancel().catch(() => {});
    socket.once("close", onClose);
    try {
      while (!socket.destroyed) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (!socket.write(value)) {
          await drained(socket);
        }
      }
    } catch (error) {
      // e.g. an upstream body cut off mid-stream. The head is already sent, so
      // all the client can be told is that the connection dropped.
      console.error("[crossws] [node] Failed to write upgrade rejection body:", error);
      socket.destroy();
    } finally {
      socket.off("close", onClose);
      // Stops the source if the client went away before the body was read.
      reader.cancel().catch(() => {});
    }
  }

  if (socket.destroyed) {
    return;
  }
  return new Promise<void>((resolve) => {
    socket.end(() => {
      socket.destroy();
      resolve();
    });
  });
}

function encodeResponse(res: Response) {
  // Lock `body` first, so an invalid response throws before anything is
  // written: srvx's `FastResponse` validates its init lazily here, and an
  // already read or locked body can't be read again.
  const reader = res.body?.getReader();
  // The socket is closed after the response, so the body is close-delimited:
  // drop framing/keep-alive headers and mark the connection as closing, while
  // keeping any other `connection` tokens (e.g. `upgrade` alongside `Upgrade`).
  const headers = new Headers(res.headers);
  headers.delete("transfer-encoding");
  headers.delete("keep-alive");
  const tokens = (headers.get("connection") || "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token && token !== "close" && token !== "keep-alive");
  headers.set("connection", [...tokens, "close"].join(", "));
  // `Response.error()` has status 0: a failed response, not a 200.
  const status = res.status || 500;
  // Only HTAB, SP, VCHAR and obs-text are allowed in a reason phrase; never let
  // a CR/LF split the response.
  const statusText = (res.statusText || "").replace(/[^\t\x20-\x7E\x80-\xFF]/g, "");
  const head = [
    `HTTP/1.1 ${status} ${statusText}`,
    ...[...headers].map(([key, value]) => `${key}: ${value}`),
  ];
  return { head: head.join("\r\n") + "\r\n\r\n", reader };
}

function drained(socket: Duplex) {
  return new Promise<void>((resolve) => {
    // A write to an already destroyed socket returns `false`, but its `close`
    // has been emitted already and would never fire again.
    if (socket.destroyed) {
      resolve();
      return;
    }
    const done = () => {
      socket.off("drain", done);
      socket.off("close", done);
      resolve();
    };
    socket.on("drain", done);
    socket.on("close", done);
  });
}
