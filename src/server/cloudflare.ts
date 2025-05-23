import { serve as srvxServe } from "srvx/cloudflare";
import adapter from "../adapters/cloudflare";

import type { Server, ServerPlugin } from "srvx/types";
import type { WSOptions, ServerWithWSOptions } from "./_types";

export function plugin(wsOpts: WSOptions): ServerPlugin {
  return (server) => {
    const ws = adapter({
      hooks: wsOpts,
      resolve: wsOpts.resolve,
      ...wsOpts.options?.cloudflare,
    });
    server.options.middleware.unshift((req, next) => {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        return ws.handleUpgrade(
          req,
          req.runtime!.cloudflare!.env,
          req.runtime!.cloudflare!.context,
        );
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
  return srvxServe(options) as unknown as Server; // cloudflare fetch types are incompatible...
}
