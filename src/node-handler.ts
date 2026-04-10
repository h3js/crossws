import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { ServerRequest } from "srvx";
import type { Hooks } from "./hooks.ts";

/**
 * A Node.js `(req, socket, head)` upgrade handler.
 */
export type NodeUpgradeHandler = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => void | Promise<void>;

/**
 * Wrap a Node.js `(req, socket, head)` upgrade handler as a {@link Hooks}
 * object that can be mounted via `crossws/server/node`.
 *
 * The wrapped handler takes ownership of the socket; crossws's other
 * lifecycle hooks (`open`/`message`/`close`/`error`) are **not** invoked
 * for connections routed through it.
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
export function fromNodeUpgradeHandler(handler: NodeUpgradeHandler): Partial<Hooks> {
  return {
    async upgrade(request) {
      const node = (request as ServerRequest).runtime?.node as
        | {
            req: IncomingMessage;
            upgrade?: { socket: Duplex; head: Buffer };
          }
        | undefined;
      if (!node?.upgrade) {
        throw new Error(
          "[crossws] `fromNodeUpgradeHandler` must be mounted via `crossws/server/node`.",
        );
      }
      await handler(node.req, node.upgrade.socket, node.upgrade.head);
      return { handled: true };
    },
  };
}
