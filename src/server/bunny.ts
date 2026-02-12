import { serve as srvxServe } from "srvx";
import adapter from "../adapters/bunny";

import type { Server, ServerPlugin } from "srvx";
import type { WSOptions, ServerWithWSOptions } from "./_types";

export function plugin(wsOpts: WSOptions): ServerPlugin {
  return (server) => {
    const ws = adapter({
      hooks: wsOpts,
      resolve: wsOpts.resolve,
      ...wsOpts.options?.bunny,
    });

    server.options.middleware.unshift((req, next) => {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        return ws.handleUpgrade(req);
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
