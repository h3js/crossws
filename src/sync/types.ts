import type { MaybePromise } from "../hooks.ts";

/**
 * A single pub/sub event relayed between crossws instances.
 *
 * This is the minimal unit a sync backplane needs to transport so that a
 * `peer.publish()` (or `adapter.publish()`) on one instance reaches the
 * subscribers connected to every other instance.
 */
export interface SyncMessage {
  /**
   * Pub/sub namespace (matches {@link Peer.namespace}).
   *
   * An empty string means "all namespaces" and mirrors a server-side
   * `adapter.publish(topic, data)` call without an explicit `namespace`.
   */
  namespace: string;

  /** Channel / topic name. */
  topic: string;

  /**
   * Message payload.
   *
   * crossws normalizes payloads to a string or `Uint8Array` before handing
   * them to the driver. Encoding for the wire (e.g. base64 for binary over a
   * text transport) is the driver's responsibility.
   */
  data: string | Uint8Array;
}

/**
 * A live connection to a sync backplane, scoped to one crossws instance.
 *
 * Created by a {@link SyncAdapter}. crossws calls {@link SyncDriver.publish}
 * for every local publish and expects {@link SyncDriver.subscribe} to invoke
 * the supplied `deliver` callback for every message originating from *other*
 * instances.
 */
export interface SyncDriver {
  /**
   * Start receiving messages relayed from other instances.
   *
   * The driver MUST call `deliver` for every remote message; crossws then
   * fans it out to local subscribers. The driver MUST NOT echo this
   * instance's own publishes back (backplanes like Redis pub/sub echo by
   * default — use the instance `id` from {@link SyncAdapter} to filter).
   */
  subscribe(deliver: (message: SyncMessage) => void): MaybePromise<void>;

  /** Relay a locally-published message to the other instances. */
  publish(message: SyncMessage): MaybePromise<void>;

  /** Optional teardown when the adapter shuts down. */
  close?(): MaybePromise<void>;
}

/**
 * Factory for a {@link SyncDriver}.
 *
 * crossws calls it once per adapter instance and passes a stable random `id`
 * the driver can use for echo suppression.
 */
export type SyncAdapter = (ctx: { id: string }) => SyncDriver;
