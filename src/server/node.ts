import { serve as srvxServe, NodeRequest } from "srvx/node";
import adapter from "../adapters/node";
import { defaultResolve } from "./_resolve";

import type { Duplex } from "node:stream";
import type { Server, ServerPlugin, ServerOptions } from "srvx";
import type { WSOptions, ServerWithWSOptions } from "./_types";

export function plugin(wsOpts: WSOptions): ServerPlugin {
  return (server) => {
    const ws = adapter({
      hooks: wsOpts,
      resolve: defaultResolve(server, wsOpts),
      ...wsOpts.options?.node,
    });
    // Raw sockets of in-flight and upgraded connections; `closeAllConnections()`
    // can't reach them once Node emits `upgrade`.
    const upgradeSockets = new Set<Duplex>();
    let upgradeListenerAdded = false;
    const originalServe = server.serve;
    server.serve = () => {
      if (upgradeListenerAdded) {
        return originalServe.call(server);
      }
      upgradeListenerAdded = true;
      server.node?.server!.on("upgrade", (req, socket, head) => {
        upgradeSockets.add(socket);
        socket.once("close", () => upgradeSockets.delete(socket));
        // Same request context srvx builds for regular requests.
        const request = new NodeRequest({
          req,
          // @ts-expect-error (upgrade is not typed)
          upgrade: { socket, head },
          trustProxy: server.options.trustProxy,
        });
        request.waitUntil = server.waitUntil;
        // Rejections from `handleUpgrade` itself (e.g. writing a rejection
        // response); fire-and-forget hook calls are not covered here.
        ws.handleUpgrade(req, socket, head, request).catch((error) => {
          socket.destroy();
          if (!server.options.silent) {
            console.error("[crossws] WebSocket upgrade failed:", error);
          }
        });
      });
      return originalServe.call(server);
    };
    // `closeAllConnections()` doesn't reach upgraded sockets, so terminate the
    // peers here. A graceful `close()` leaves them open (like Bun).
    const originalClose = server.close;
    server.close = async (closeActiveConnections) => {
      const closing = originalClose.call(server, closeActiveConnections);
      if (!closeActiveConnections) {
        return closing;
      }
      for (const socket of upgradeSockets) {
        socket.destroy();
      }
      await Promise.all([ws.close(), closing]);
    };
  };
}

export function serve(options: ServerWithWSOptions): Server {
  if (options.websocket) {
    options.plugins ||= [];
    options.plugins.push(plugin(options.websocket));
  }
  return srvxServe(options as ServerOptions);
}
