import { serve as srvxServe, NodeRequest } from "srvx/node";
import adapter from "../adapters/node";
import { defaultResolve } from "./_resolve";

import type { Server, ServerPlugin, ServerOptions } from "srvx";
import type { WSOptions, ServerWithWSOptions } from "./_types";

export function plugin(wsOpts: WSOptions): ServerPlugin {
  return (server) => {
    const ws = adapter({
      hooks: wsOpts,
      resolve: defaultResolve(server, wsOpts),
      ...wsOpts.options?.node,
    });
    const originalServe = server.serve;
    server.serve = () => {
      server.node?.server!.on("upgrade", (req, socket, head) => {
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
          console.error("[crossws] WebSocket upgrade failed:", error);
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
      ws.closeAll(undefined, undefined, true);
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
