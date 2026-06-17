import { serve as srvxServe } from "srvx";
import adapter from "../adapters/sse";

import type { Server, ServerPlugin } from "srvx";
import type { WSOptions, ServerWithWSOptions } from "./_types";

export function plugin(wsOpts: WSOptions): ServerPlugin {
  const ws = adapter({
    hooks: wsOpts,
    resolve: wsOpts.resolve,
    ...wsOpts.options?.sse,
  });
  console.warn(
    "[crossws] Using SSE adapter for WebSocket support. This requires a custom WebSocket client (https://crossws.h3.dev/adapters/sse).",
  );
  return (server) => {
    server.options.middleware.unshift((req, next) => {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        return ws.fetch(req);
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
