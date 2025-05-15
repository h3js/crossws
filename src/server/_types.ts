import type {
  Server,
  ServerPlugin,
  ServerOptions,
  ServerRequest,
} from "srvx/types";

import type { Hooks } from "../hooks";

import type { BunOptions } from "../adapters/bun";
import type { DenoOptions } from "../adapters/deno";
import type { NodeOptions } from "../adapters/node";

export type WSOptions = Partial<Hooks> & {
  resolve?: (req: ServerRequest) => Partial<Hooks> | Promise<Partial<Hooks>>;
  options?: {
    bun?: BunOptions;
    deno?: DenoOptions;
    node?: NodeOptions;
  };
};

export type ServerWithWSOptions = ServerOptions & { websocket?: WSOptions };

export declare function plugin(options: WSOptions): ServerPlugin;

export declare function serve(options: ServerWithWSOptions): Server;
