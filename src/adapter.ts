import type { Hooks, ResolveHooks } from "./hooks.ts";
import type { Peer } from "./peer.ts";

export function adapterUtils(
  globalPeers: Map<string, Set<Peer>>,
): AdapterInstance {
  return {
    peers: globalPeers,
    publish(topic: string, message: any, options) {
      for (const peers of options?.namespace
        ? [globalPeers.get(options.namespace) || []]
        : globalPeers.values()) {
        let firstPeerWithTopic: Peer | undefined;
        for (const peer of peers) {
          if (peer.topics.has(topic)) {
            firstPeerWithTopic = peer;
            break;
          }
        }
        if (firstPeerWithTopic) {
          firstPeerWithTopic.send(message, options);
          firstPeerWithTopic.publish(topic, message, options);
        }
      }
    },
  } satisfies AdapterInstance;
}

export function getNamespace(opts: AdapterOptions, request: Request) {
  return opts.getNamespace?.(request) ?? new URL(request.url).pathname;
}

export function getPeers<T extends Peer = Peer>(
  globalPeers: Map<string, Set<T>>,
  namespace: string,
): Set<T> {
  let peers = globalPeers.get(namespace || "");
  if (!peers) {
    peers = new Set<T>();
    globalPeers.set(namespace, peers);
  }
  return peers;
}

// --- types ---

export interface AdapterInstance {
  readonly peers: Map<string, Set<Peer>>;
  readonly publish: (
    topic: string,
    data: unknown,
    options?: { compress?: boolean; namespace?: string },
  ) => void;
}

export interface AdapterOptions {
  resolve?: ResolveHooks;
  getNamespace?: (request: Request) => string;
  hooks?: Partial<Hooks>;
}

export type Adapter<
  AdapterT extends AdapterInstance = AdapterInstance,
  Options extends AdapterOptions = AdapterOptions,
> = (options?: Options) => AdapterT;

export function defineWebSocketAdapter<
  AdapterT extends AdapterInstance = AdapterInstance,
  Options extends AdapterOptions = AdapterOptions,
>(factory: Adapter<AdapterT, Options>): Adapter<AdapterT, Options> {
  return factory;
}
