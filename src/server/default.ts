import { serve as srvxServe } from "srvx";

import type { Server, ServerPlugin } from "srvx/types";
import type { WSOptions, ServerWithWSOptions } from "./_types";

export function plugin(_wsOpts: WSOptions): ServerPlugin {
  return (server) => {
    server.options.middleware.unshift((req, next) => {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        return new Response(`WebSocket upgrade not supported.`, {
          status: 400,
          statusText: "Bad Request",
          headers: {
            "content-type": "text/plain",
          },
        });
      }
      return next();
    });
  };
}

export function serve(options: ServerWithWSOptions): Server {
  if (options.websocket) {
    options.plugins ||= [];
    options.plugins.push(plugin(options.websocket));
  }
  return srvxServe(options);
}
