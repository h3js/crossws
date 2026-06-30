import type { Hooks, ResolveHooks } from "./hooks.ts";
import type { Peer } from "./peer.ts";
import type { SyncAdapter, SyncDriver, SyncMessage } from "./sync.ts";
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
  //
  // Caveat: because native `ws.publish` is app-wide, a *namespaced* publish on a
  // native adapter still reaches same-topic subscribers in other namespaces —
  // namespace isolation is best-effort there (true on the local path and, via
  // the sync relay, cross-instance too). Loop-based adapters honor namespaces.
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
    // Every sync operation is fire-and-forget (a flaky backplane must never
    // crash the app or surface as an unhandled rejection), so this reporter is
    // the only window into a degraded backplane. Route every failure through
    // the user's `onError`, falling back to `console.error`.
    const report = (stage: SyncErrorContext["stage"], error: unknown) => {
      if (options.onError) {
        options.onError(error, { stage });
      } else {
        console.error(`[crossws] sync ${stage} failed:`, error);
      }
    };
    const driver = options.sync({ id: crypto.randomUUID() });
    const deliver = (msg: SyncMessage) => {
      // A failing subscriber send must not break the relay nor bubble into the
      // driver's transport callback (e.g. a Redis "message" handler); isolate
      // per-delivery errors here.
      try {
        // `""` namespace means "all namespaces" (server-side global publish).
        localPublish(msg.topic, msg.data, { namespace: msg.namespace || undefined });
      } catch (error) {
        report("delivery", error);
      }
    };
    // Setup must never crash adapter construction: catch a synchronous throw
    // (e.g. a driver that opens a connection eagerly in a restricted scope like
    // workerd module-init) as well as an async subscribe rejection.
    try {
      Promise.resolve(driver.subscribe(deliver)).catch((error) => report("subscribe", error));
    } catch (error) {
      report("subscribe", error);
    }
    // Wrap the driver so the relay callers below (and `Peer.publish`, which
    // shares this same instance via `_internal.sync`) can fire-and-forget
    // without each re-implementing rejection isolation: a publish rejection
    // (e.g. a dropped backplane connection) is caught here and reported.
    sync = {
      subscribe: (deliver) => driver.subscribe(deliver),
      publish: (msg) => Promise.resolve(driver.publish(msg)).catch((e) => report("publish", e)),
      close: driver.close ? () => driver.close!() : undefined,
    };
  }

  return {
    peers: globalPeers,
    sync,
    publish(topic: string, message: any, options) {
      localPublish(topic, message, options);
      // Fire-and-forget relay; `sync.publish` isolates its own rejections.
      sync?.publish({
        namespace: options?.namespace || "",
        topic,
        data: serializeMessage(message),
      });
    },
    async close(code, reason) {
      // Gracefully close every connected peer via the adapter-specific
      // `Peer.close`, then tear down the sync backplane. Peers are removed from
      // `globalPeers` by their async close handlers (after the socket actually
      // closes), so iterating the live Sets here is safe.
      for (const peers of globalPeers.values()) {
        for (const peer of peers) {
          peer.close(code, reason);
        }
      }
      await sync?.close?.();
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
  /**
   * Gracefully shut the adapter down: close every connected peer (with the
   * optional `code` / `reason`) and tear down the {@link AdapterInstance.sync}
   * backplane. Any underlying server you created (e.g. an `http.Server` or a
   * `WebSocketServer` passed via options) stays yours to close.
   */
  readonly close: (code?: number, reason?: string) => Promise<void>;
  /**
   * Sync backplane driver, present when an adapter is created with `sync`.
   *
   * Closed automatically by {@link AdapterInstance.close}; it leaves any
   * user-owned client (Redis/Postgres) connected.
   */
  readonly sync?: SyncDriver;
}

/** Context passed to {@link AdapterOptions.onError} describing what failed. */
export interface SyncErrorContext {
  /**
   * Which backplane operation failed:
   * - `subscribe` — the initial subscription to the backplane.
   * - `publish` — relaying a local publish out to the other instances.
   * - `delivery` — fanning an inbound remote message out to local subscribers.
   */
  stage: "subscribe" | "publish" | "delivery";
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
  /**
   * Called when a {@link AdapterOptions.sync} backplane operation fails.
   *
   * Relay is fire-and-forget by design — a flaky backplane never throws into
   * your `publish` call or crashes the process — so this callback is the only
   * way to observe a degraded backplane (for logging, metrics or alerting).
   * Defaults to `console.error`. Has no effect without `sync`.
   */
  onError?: (error: unknown, context: SyncErrorContext) => void;
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
