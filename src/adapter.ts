import type { Hooks, ResolveHooks } from "./hooks.ts";
import type { Peer } from "./peer.ts";
import type { SyncAdapter, SyncDriver } from "./sync.ts";
import { serializeMessage } from "./utils.ts";

export function adapterUtils(
  globalPeers: Map<string, Set<Peer>>,
  options?: AdapterOptions,
  caps?: { nativePubSub?: boolean },
): AdapterInstance {
  // Relay-free local fan-out: deliver `message` to every local subscriber of
  // `topic`. Reused both for the public `publish` and for delivering messages
  // relayed from other instances (the latter must NOT echo back to the sync
  // backplane, hence `_publish` rather than the relay-aware `publish`).
  //
  // Native pub/sub adapters (bun, uWebSockets) broadcast a topic app-wide with
  // a single `ws.publish(topic)` that ignores namespaces. For a global publish
  // (no `namespace`) we therefore stop after the first namespace with a match:
  // a second `_publish` would re-broadcast app-wide and deliver every message
  // again. Loop-based adapters fan out within a single namespace Set, so they
  // must visit every namespace.
  const localPublish = (
    topic: string,
    message: any,
    pubOptions?: { compress?: boolean; namespace?: string },
  ) => {
    for (const peers of pubOptions?.namespace
      ? [globalPeers.get(pubOptions.namespace) || []]
      : globalPeers.values()) {
      let firstPeerWithTopic: Peer | undefined;
      for (const peer of peers) {
        if (peer.topics.has(topic)) {
          firstPeerWithTopic = peer;
          break;
        }
      }
      if (firstPeerWithTopic) {
        firstPeerWithTopic.send(message, pubOptions);
        firstPeerWithTopic._publish(topic, message, pubOptions);
        if (caps?.nativePubSub && !pubOptions?.namespace) {
          // `_publish` already reached every subscriber app-wide.
          break;
        }
      }
    }
  };

  let sync: SyncDriver | undefined;
  if (options?.sync) {
    sync = options.sync({ id: crypto.randomUUID() });
    Promise.resolve(
      sync.subscribe((msg) => {
        // A failing subscriber send must not break the relay nor bubble into
        // the driver's transport callback (e.g. a Redis "message" handler);
        // isolate per-delivery errors here.
        try {
          // `""` namespace means "all namespaces" (server-side global publish).
          localPublish(msg.topic, msg.data, { namespace: msg.namespace || undefined });
        } catch (error) {
          console.error("[crossws] sync delivery failed:", error);
        }
      }),
    ).catch((error) => {
      console.error("[crossws] failed to subscribe to sync backplane:", error);
    });
  }

  return {
    peers: globalPeers,
    sync,
    publish(topic: string, message: any, options) {
      localPublish(topic, message, options);
      sync?.publish({
        namespace: options?.namespace || "",
        topic,
        data: serializeMessage(message),
      });
    },
  } satisfies AdapterInstance;
}

export function getPeers<T extends Peer = Peer>(
  globalPeers: Map<string, Set<T>>,
  namespace: string,
): Set<T> {
  if (!namespace) {
    throw new Error("Websocket publish namespace missing.");
  }
  let peers = globalPeers.get(namespace);
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
  /** Sync backplane driver, present when an adapter is created with `sync`. */
  readonly sync?: SyncDriver;
}

export interface AdapterOptions {
  resolve?: ResolveHooks;
  getNamespace?: (request: Request) => string;
  hooks?: Partial<Hooks>;
  /**
   * Optional sync backplane to relay pub/sub between multiple crossws
   * instances (e.g. across regions/processes). Opt-in: when absent, pub/sub
   * stays local to the instance, exactly as before.
   */
  sync?: SyncAdapter;
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
