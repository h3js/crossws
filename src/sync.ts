export type { SyncMessage, SyncDriver, SyncAdapter } from "./sync/types.ts";

import { broadcastChannel } from "./sync/broadcast-channel.ts";
import { redis } from "./sync/redis.ts";
import { pgsql } from "./sync/pgsql.ts";
import { cluster } from "./sync/cluster.ts";

export { broadcastChannel } from "./sync/broadcast-channel.ts";

export { redis, type RedisClientLike } from "./sync/redis.ts";

export { pgsql, type PostgresClientLike } from "./sync/pgsql.ts";

export { cluster, setupPrimaryCluster } from "./sync/cluster.ts";

// Wire envelope helpers — handy when writing a custom driver.
export { encodeEnvelope, decodeEnvelope } from "./sync/encoding.ts";

/**
 * Names of the built-in sync drivers exported from `crossws/sync`.
 *
 * Useful for automatic integration (e.g. Nitro) that needs to enumerate the
 * available drivers without importing each one.
 */
export const syncDrivers = ["broadcastChannel", "redis", "pgsql", "cluster"] as const;

/** Name of a built-in sync driver (see {@link syncDrivers}). */
export type SyncDriverName = (typeof syncDrivers)[number];

/**
 * Map from a {@link SyncDriverName} to the options object its driver factory
 * accepts — derived from the factory signatures so it stays in sync.
 */
export type SyncDriverOptions = {
  broadcastChannel: Parameters<typeof broadcastChannel>[0];
  redis: Parameters<typeof redis>[0];
  pgsql: Parameters<typeof pgsql>[0];
  cluster: Parameters<typeof cluster>[0];
};
