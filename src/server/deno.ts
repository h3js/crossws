import { serve as srvxServe } from "srvx/deno";
import adapter from "../adapters/deno";

import type { Server, ServerPlugin } from "srvx/types";
import type { WSOptions, ServerWithWSOptions } from "./_types";

export function plugin(wsOpts: WSOptions): ServerPlugin {
  return (server) => {
    const ws = adapter({ hooks: wsOpts, ...wsOpts.options?.deno });

    server.options.middleware.unshift((req, next) => {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        return ws._srvxUpgrade!(req);
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
