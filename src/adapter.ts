import type { Hooks, ResolveHooks } from "./hooks.ts";
import type { Peer } from "./peer.ts";

export function adapterUtils(peers: Set<Peer>) {
  return {
    peers,
    publish(topic: string, message: any, options) {
      const firstPeer = peers.values().next().value as Peer;
      if (firstPeer) {
        firstPeer.send(message, options);
        firstPeer.publish(topic, message, options);
      }
    },
  } satisfies AdapterInstance;
}

// --- types ---

export interface AdapterInstance {
  readonly peers: Set<Peer>;
  readonly publish: Peer["publish"];
}

export interface AdapterOptions {
  resolve?: ResolveHooks;
  hooks?: Partial<Hooks>;
}

export type Adapter<
  AdapterT extends AdapterInstance = AdapterInstance,
  Options extends AdapterOptions = AdapterOptions,
> = (options?: Options) => AdapterT;

export function defineWebSocketAdapter<
  AdapterT extends AdapterInstance = AdapterInstance,
  Options extends AdapterOptions = AdapterOptions,
>(factory: Adapter<AdapterT, Options>) {
  return factory;
}
