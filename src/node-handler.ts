import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Hooks } from "./hooks.ts";

/**
 * A Node.js-style WebSocket upgrade handler, matching the signature of
 * `http.Server`'s `"upgrade"` event listener and libraries like
 * [`ws`](https://github.com/websockets/ws).
 *
 * The handler takes ownership of `socket` for the remainder of the
 * connection's lifetime.
 */
export type NodeUpgradeHandler = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => void | Promise<void>;

/**
 * Wrap a Node.js-style `(req, socket, head)` upgrade handler as a
 * {@link Hooks} object so it can be plugged into crossws.
 *
 * This is useful when you have an existing Node.js WebSocket library
 * (e.g. `ws`, `socket.io`, `express-ws`) that exposes a raw upgrade
 * handler, and you want to route to it through crossws without giving
 * up crossws's upgrade-time request handling.
 *
 * The returned hooks object only implements `upgrade`: the underlying
 * handler takes full ownership of the socket, so crossws's other
 * lifecycle hooks (`open`, `message`, `close`, `error`) are **not**
 * invoked for connections routed through it. Manage the WebSocket
 * lifecycle inside your own library as usual.
 *
 * > [!NOTE]
 * > Only works on the Node.js runtime. The incoming request must carry
 * > the srvx node runtime context (`request.runtime.node.req` and
 * > `request.runtime.node.upgrade.{socket, head}`), which crossws's
 * > node server plugin provides automatically.
 *
 * @example
 * ```ts
 * import { WebSocketServer } from "ws";
 * import { fromNodeUpgradeHandler } from "crossws/adapters/node";
 * import { serve } from "crossws/server/node";
 *
 * const wss = new WebSocketServer({ noServer: true });
 * wss.on("connection", (ws) => {
 *   ws.on("message", (data) => ws.send(data));
 * });
 *
 * serve({
 *   websocket: fromNodeUpgradeHandler((req, socket, head) => {
 *     wss.handleUpgrade(req, socket, head, (ws) => {
 *       wss.emit("connection", ws, req);
 *     });
 *   }),
 *   fetch: () => new Response("ok"),
 * });
 * ```
 */
export function fromNodeUpgradeHandler(
  handler: NodeUpgradeHandler,
): Partial<Hooks> {
  return {
    async upgrade(request) {
      const nodeCtx = (request as { runtime?: { node?: NodeUpgradeRuntime } })
        .runtime?.node;
      const req = nodeCtx?.req as IncomingMessage | undefined;
      const upgrade = nodeCtx?.upgrade;
      if (!req || !upgrade?.socket) {
        throw new Error(
          "[crossws] `fromNodeUpgradeHandler` requires a Node.js upgrade request. " +
            "Make sure it is used via the crossws node server plugin so the " +
            "request carries `runtime.node.upgrade.{socket, head}`.",
        );
      }
      await handler(req, upgrade.socket, upgrade.head ?? Buffer.alloc(0));
      return { handled: true };
    },
  };
}

interface NodeUpgradeRuntime {
  req: IncomingMessage;
  upgrade?: {
    socket: Duplex;
    head?: Buffer;
  };
}
