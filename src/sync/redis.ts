import type { SyncAdapter } from "./types.ts";
import { decodeEnvelope, encodeEnvelope } from "./encoding.ts";

/**
 * Structural subset of a Redis client used by {@link redis}, covering both
 * [ioredis](https://github.com/redis/ioredis) and
 * [node-redis](https://github.com/redis/node-redis). Kept structural so crossws
 * stays dependency-free.
 *
 * The two clients shape pub/sub differently and {@link redis} bridges them:
 * - **ioredis** — `subscribe(channel)` plus a shared `"message"` event whose
 *   listener receives `(channel, message)`; `duplicate()` returns a ready client.
 * - **node-redis** — `subscribe(channel, listener)` with an inline listener that
 *   receives `(message, channel)`; `duplicate()` returns a client you must
 *   `connect()` first.
 */
export interface RedisClientLike {
  publish(channel: string, message: string): unknown;
  /**
   * ioredis: `subscribe(channel)`; node-redis: `subscribe(channel, listener)`
   * (the listener receives `(message, channel)`).
   */
  subscribe(channel: string, listener?: (message: string, channel: string) => void): unknown;
  /** ioredis: shared `"message"` event (listener receives `(channel, message)`). */
  on?(event: "message", listener: (channel: string, message: string) => void): unknown;
  /** ioredis: detach the `"message"` listener on {@link SyncDriver.close}. */
  off?(event: "message", listener: (channel: string, message: string) => void): unknown;
  /** node-redis: a `duplicate()`d client starts disconnected and must `connect()`. */
  connect?(): unknown;
  /** Create a second connection for `SUBSCRIBE` (which blocks the connection). */
  duplicate(): RedisClientLike;
  /** Tear down the dedicated subscriber connection on {@link SyncDriver.close}. */
  quit?(): unknown;
  /** Present (camelCase) only on node-redis — used for auto-detection. */
  pSubscribe?: unknown;
}

/**
 * Networked sync driver over Redis pub/sub — the realistic multi-region
 * backplane. Bring your own client; a dedicated `SUBSCRIBE` connection is
 * derived from it via `duplicate()` (`SUBSCRIBE` blocks the connection it runs
 * on, so it can't share the one used for `PUBLISH`).
 *
 * Works out of the box with both [ioredis](https://github.com/redis/ioredis)
 * and [node-redis](https://github.com/redis/node-redis): the flavor is
 * auto-detected (node-redis exposes camelCase commands such as `pSubscribe`),
 * with an explicit `connector` escape hatch if detection ever guesses wrong.
 *
 * Binary payloads are base64-encoded so they survive Redis's text transport.
 *
 * A `channel` name is required: it scopes the cluster, and a shared default
 * would risk silently bridging unrelated servers on the same Redis instance.
 *
 * Reconnect note: ioredis auto-resubscribes its channels after a dropped
 * connection; node-redis does not restore subscriptions the same way, so a
 * node-redis-backed instance may stop receiving relayed messages after a
 * transient outage. Prefer ioredis where connection resilience matters.
 *
 * @example
 * ```js
 * // ioredis
 * import Redis from "ioredis";
 * import { redis } from "crossws/sync";
 * const adapter = nodeAdapter({ hooks, sync: redis({ client: new Redis(), channel: "my-app" }) });
 * ```
 *
 * @example
 * ```js
 * // node-redis
 * import { createClient } from "redis";
 * import { redis } from "crossws/sync";
 * const client = await createClient().connect();
 * const adapter = nodeAdapter({ hooks, sync: redis({ client, channel: "my-app" }) });
 * ```
 */
export function redis(opts: {
  /** Redis client used to `PUBLISH`; a subscriber is `duplicate()`d from it. */
  client: RedisClientLike;
  /** Pub/sub channel to relay over. */
  channel: string;
  /**
   * Client flavor. Defaults to auto-detection (node-redis exposes the camelCase
   * `pSubscribe` command; ioredis does not). Set explicitly to override.
   */
  connector?: "ioredis" | "node-redis";
}): SyncAdapter {
  const channel = opts.channel;
  // node-redis exposes camelCase commands (pSubscribe); ioredis uses lowercase.
  const isNodeRedis =
    opts.connector === undefined
      ? typeof opts.client.pSubscribe === "function"
      : opts.connector === "node-redis";
  return ({ id }) => {
    const subscriber = opts.client.duplicate();
    // Tracks whether subscribe() ran so close() doesn't quit() a node-redis
    // subscriber that was never connect()ed (which throws on an unopened client).
    let started = false;
    // ioredis "message" listener — kept so close() can detach it.
    let onMessage: ((channel: string, message: string) => void) | undefined;
    return {
      async subscribe(deliver) {
        started = true;
        const handle = (raw: string) => {
          const envelope = decodeEnvelope(raw);
          if (!envelope || envelope.id === id) {
            return;
          }
          deliver(envelope.msg);
        };
        if (isNodeRedis) {
          // node-redis: a duplicated client is disconnected and the listener is
          // passed inline (args are `(message, channel)`).
          await subscriber.connect?.();
          await subscriber.subscribe(channel, (raw) => handle(raw));
        } else {
          // ioredis: a shared `"message"` event (args are `(channel, message)`).
          onMessage = (ch, raw) => {
            if (ch === channel) {
              handle(raw);
            }
          };
          subscriber.on?.("message", onMessage);
          await subscriber.subscribe(channel);
        }
      },
      async publish(msg) {
        await opts.client.publish(channel, encodeEnvelope(id, msg));
      },
      async close() {
        // Tear down the dedicated subscriber connection opened in subscribe().
        // Guard on `started`: a never-subscribed node-redis client is still
        // disconnected, and quit() on it throws. Best-effort, so swallow errors.
        if (!started) {
          return;
        }
        if (onMessage) {
          subscriber.off?.("message", onMessage);
          onMessage = undefined;
        }
        try {
          await subscriber.quit?.();
        } catch (error) {
          console.error("[crossws] sync redis close failed:", error);
        }
      },
    };
  };
}
