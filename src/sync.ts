import type { MaybePromise } from "./hooks.ts";

// --- types ---

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

// --- drivers ---

/**
 * Zero-dependency sync driver built on [`BroadcastChannel`](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel).
 *
 * Works across worker threads / processes that share a `BroadcastChannel`
 * implementation (Node.js, Deno, Bun, Cloudflare Workers). Great for tests and
 * single-host multi-worker deployments. For multi-region you want a networked
 * driver such as {@link redisSync}.
 *
 * @example
 * ```js
 * import { broadcastChannelSync } from "crossws/sync";
 * const adapter = nodeAdapter({ hooks, sync: broadcastChannelSync() });
 * ```
 */
export function broadcastChannelSync(opts: { name?: string } = {}): SyncAdapter {
  return ({ id }) => {
    const channel = new BroadcastChannel(opts.name || "crossws:sync");
    return {
      subscribe(deliver) {
        channel.addEventListener("message", (event: MessageEvent) => {
          const envelope = event.data as { id: string; msg: SyncMessage };
          if (!envelope || envelope.id === id) {
            return; // ignore malformed and our own messages
          }
          deliver(envelope.msg);
        });
      },
      publish(msg) {
        channel.postMessage({ id, msg });
      },
      close() {
        channel.close();
      },
    } satisfies SyncDriver;
  };
}

/**
 * Minimal subset of an [ioredis](https://github.com/redis/ioredis)-compatible
 * client used by {@link redisSync}. Kept structural so crossws stays
 * dependency-free.
 */
export interface RedisClientLike {
  publish(channel: string, message: string): unknown;
  subscribe(channel: string): unknown;
  on(event: "message", listener: (channel: string, message: string) => void): unknown;
}

/**
 * Example networked sync driver over Redis pub/sub — the realistic multi-region
 * backplane. Bring your own client (two connections: one for `SUBSCRIBE`, which
 * blocks the connection, and one for `PUBLISH`).
 *
 * Binary payloads are base64-encoded so they survive Redis's text transport.
 *
 * @example
 * ```js
 * import Redis from "ioredis";
 * import { redisSync } from "crossws/sync";
 * const adapter = nodeAdapter({
 *   hooks,
 *   sync: redisSync({ publisher: new Redis(), subscriber: new Redis() }),
 * });
 * ```
 */
export function redisSync(opts: {
  publisher: RedisClientLike;
  subscriber: RedisClientLike;
  channel?: string;
}): SyncAdapter {
  const channel = opts.channel || "crossws:sync";
  return ({ id }) => ({
    async subscribe(deliver) {
      opts.subscriber.on("message", (ch, raw) => {
        if (ch !== channel) {
          return;
        }
        const envelope = decodeEnvelope(raw);
        if (!envelope || envelope.id === id) {
          return;
        }
        deliver(envelope.msg);
      });
      await opts.subscriber.subscribe(channel);
    },
    async publish(msg) {
      await opts.publisher.publish(channel, encodeEnvelope(id, msg));
    },
  });
}

// --- wire encoding (used by networked text-transport drivers) ---

function encodeEnvelope(id: string, msg: SyncMessage): string {
  const binary = msg.data instanceof Uint8Array;
  return JSON.stringify({
    id,
    msg: {
      namespace: msg.namespace,
      topic: msg.topic,
      binary,
      data: binary ? toBase64(msg.data as Uint8Array) : msg.data,
    },
  });
}

function decodeEnvelope(raw: string): { id: string; msg: SyncMessage } | undefined {
  try {
    const parsed = JSON.parse(raw) as {
      id: string;
      msg: { namespace: string; topic: string; binary?: boolean; data: string };
    };
    return {
      id: parsed.id,
      msg: {
        namespace: parsed.msg.namespace,
        topic: parsed.msg.topic,
        data: parsed.msg.binary ? fromBase64(parsed.msg.data) : parsed.msg.data,
      },
    };
  } catch {
    return undefined;
  }
}

function toBase64(data: Uint8Array): string {
  let binary = "";
  for (const byte of data) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(data: string): Uint8Array {
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
