import { serve as srvxServe, NodeRequest } from "srvx/node";
import adapter from "../adapters/node";

import type { Server, ServerPlugin } from "srvx";
import type { WSOptions, ServerWithWSOptions } from "./_types";

export function plugin(wsOpts: WSOptions): ServerPlugin {
  return (server) => {
    const ws = adapter({
      hooks: wsOpts,
      resolve: wsOpts.resolve,
      ...wsOpts.options?.deno,
    });
    const originalServe = server.serve;
    server.serve = () => {
      server.node?.server!.on("upgrade", (req, socket, head) => {
        ws.handleUpgrade(
          req,
          socket,
          head,
          // @ts-expect-error (upgrade is not typed)
          new NodeRequest({ req, upgrade: { socket, head } }),
        );
      });
      return originalServe.call(server);
    };
  };
}

export function serve(options: ServerWithWSOptions): Server {
  if (options.websocket) {
    options.plugins ||= [];
    options.plugins.push(plugin(options.websocket));
  }
  return srvxServe(options);
}
