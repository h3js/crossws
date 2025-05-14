import { serve as srvxServe } from "srvx/bun";
import adapter from "../adapters/bun";

import type { Server, ServerPlugin } from "srvx/types";
import type { WSOptions, ServerWithWSOptions } from "./_types";

export function plugin(wsOpts: WSOptions): ServerPlugin {
  return (server) => {
    const ws = adapter({ hooks: wsOpts, ...wsOpts.options?.bun });

    server.options.middleware.unshift((req, next) => {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        return ws.handleUpgrade(
          req,
          req.runtime!.bun!.server,
        ) as Promise<Response>;
      }
      return next();
    });

    server.options.bun ??= {};
    // @ts-expect-error
    if (server.options.bun.websocket) {
      throw new Error("websocket handlers for bun already set!");
    }
    // @ts-expect-error
    server.options.bun.websocket = ws.websocket;
  };
}

export function serve(options: ServerWithWSOptions): Server {
  if (options.websocket) {
    options.plugins ||= [];
    options.plugins.push(plugin(options.websocket));
  }
  return srvxServe(options);
}
