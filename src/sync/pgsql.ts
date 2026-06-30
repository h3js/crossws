import type { SyncAdapter } from "./types.ts";
import { decodeEnvelope, encodeEnvelope } from "./encoding.ts";

/**
 * Structural subset of a PostgreSQL client used by {@link pgsql}, covering
 * both [node-postgres](https://github.com/brianc/node-postgres) (`pg`) and
 * [postgres.js](https://github.com/porsager/postgres). Kept structural so
 * crossws stays dependency-free.
 *
 * The two clients shape `LISTEN`/`NOTIFY` differently and {@link pgsql}
 * bridges them:
 * - **node-postgres** — issue raw `LISTEN`/`pg_notify` via `query()` and receive
 *   a shared `"notification"` event whose listener gets `{ channel, payload }`.
 * - **postgres.js** — dedicated `listen(channel, onnotify)` (resolves to a
 *   handle with `unlisten()`) and `notify(channel, payload)` helpers.
 */
export interface PostgresClientLike {
  /** node-postgres: run `LISTEN` / `SELECT pg_notify(...)` / `UNLISTEN`. */
  query?(sql: string, values?: unknown[]): unknown;
  /** node-postgres: shared `"notification"` event for inbound `NOTIFY`s. */
  on?(
    event: "notification",
    listener: (msg: { channel: string; payload?: string }) => void,
  ): unknown;
  /** node-postgres: detach the `"notification"` listener on {@link SyncDriver.close}. */
  removeListener?(
    event: "notification",
    listener: (msg: { channel: string; payload?: string }) => void,
  ): unknown;
  /**
   * postgres.js: subscribe to a channel; resolves to a handle exposing
   * `unlisten()`. Present only on postgres.js — used for auto-detection.
   */
  listen?(channel: string, onnotify: (payload: string) => void): unknown;
  /** postgres.js: send a `NOTIFY` to a channel. */
  notify?(channel: string, payload: string): unknown;
}

/**
 * Networked sync driver over PostgreSQL [`LISTEN`/`NOTIFY`](https://www.postgresql.org/docs/current/sql-notify.html)
 * — a backplane for clusters that already run Postgres and would rather not add
 * Redis. Bring your own client; unlike Redis `SUBSCRIBE`, Postgres `LISTEN` does
 * not block the connection, so no `duplicate()` is needed: for node-postgres the
 * *same* client both listens and notifies. (postgres.js `listen()` internally
 * reserves its own dedicated connection — that's the client's concern, not ours.)
 *
 * Pass a single, dedicated [`Client`](https://node-postgres.com/apis/client), not
 * a [`Pool`](https://node-postgres.com/apis/pool): pool `query()` runs `LISTEN`
 * on an arbitrary backend that is then returned to the pool, so notifications
 * would never reach a stable listener. A `Pool` is detected and rejected. For the
 * same reason, don't share one client across two `pgsql()` drivers on the same
 * channel — `close()` issues a single `UNLISTEN` that would silence the others.
 *
 * Works out of the box with both [node-postgres](https://github.com/brianc/node-postgres)
 * (`pg`) and [postgres.js](https://github.com/porsager/postgres): the flavor is
 * auto-detected (postgres.js exposes a `listen()` helper; node-postgres does
 * not), with an explicit `connector` escape hatch if detection ever guesses
 * wrong.
 *
 * Binary payloads are base64-encoded so they survive the text `NOTIFY` payload.
 * Note Postgres caps a `NOTIFY` payload at 8000 bytes — keep relayed messages
 * small (this is a transport limit, not a crossws one).
 *
 * A `channel` name is required: it scopes the cluster, so unrelated servers
 * don't silently bridge through the same database. It is used verbatim as the
 * notification channel name.
 *
 * @example
 * ```js
 * // node-postgres (pg)
 * import { Client } from "pg";
 * import { pgsql } from "crossws/sync";
 * const client = new Client();
 * await client.connect();
 * const adapter = nodeAdapter({ hooks, sync: pgsql({ client, channel: "my-app" }) });
 * ```
 *
 * @example
 * ```js
 * // postgres.js
 * import postgresjs from "postgres";
 * import { pgsql } from "crossws/sync";
 * const sql = postgresjs();
 * const adapter = nodeAdapter({ hooks, sync: pgsql({ client: sql, channel: "my-app" }) });
 * ```
 */
export function pgsql(opts: {
  /** Connected Postgres client used to both `LISTEN` and `NOTIFY`. */
  client: PostgresClientLike;
  /** Notification channel to relay over. */
  channel: string;
  /**
   * Client flavor. Defaults to auto-detection (postgres.js exposes a `listen()`
   * helper; node-postgres does not). Set explicitly to override.
   */
  connector?: "pg" | "postgres.js";
}): SyncAdapter {
  const channel = opts.channel;
  // A Postgres identifier (the LISTEN channel) is capped at 63 bytes and silently
  // truncated, while `pg_notify(text)` instead *errors* past the limit — so an
  // over-long name would make subscribe half-work while every publish throws.
  // Reject it up front with a clear message rather than fail asymmetrically.
  if (new TextEncoder().encode(channel).length > 63) {
    throw new Error(
      `[crossws] pgsql sync channel name must be at most 63 bytes (got ${channel.length} chars): ${channel}`,
    );
  }
  // postgres.js exposes dedicated listen()/notify() helpers; node-postgres does
  // its LISTEN/NOTIFY through raw query().
  const isPostgresJs =
    opts.connector === undefined
      ? typeof opts.client.listen === "function"
      : opts.connector === "postgres.js";
  // A pg `Pool` is structurally a `Client` (query/on) but hands each query a
  // different backend, so LISTEN never sticks. Detect its pool-only surface
  // (idleCount/totalCount getters) and reject — only relevant on the pg path.
  if (
    !isPostgresJs &&
    "idleCount" in opts.client &&
    "totalCount" in opts.client &&
    typeof opts.client.query === "function"
  ) {
    throw new Error(
      "[crossws] pgsql sync requires a dedicated `Client`, not a `Pool` " +
        "(pool connections rotate, so LISTEN/NOTIFY can't deliver). " +
        "Pass `new Client()` (node-postgres) or a `postgres()` instance (postgres.js).",
    );
  }
  // LISTEN/UNLISTEN take an SQL identifier; quote it so the (case-sensitive)
  // name matches the text channel handed to pg_notify verbatim.
  const quotedChannel = `"${channel.replace(/"/g, '""')}"`;
  return ({ id }) => {
    let unlisten: (() => unknown) | undefined;
    // node-postgres "notification" listener — kept so close() can detach it from
    // the user-owned client (the client outlives this driver, so a leftover
    // listener would leak and double-deliver on re-subscribe).
    let onNotification: ((msg: { channel: string; payload?: string }) => void) | undefined;
    return {
      async subscribe(deliver) {
        const handle = (raw: string) => {
          const envelope = decodeEnvelope(raw);
          if (!envelope || envelope.id === id) {
            return;
          }
          deliver(envelope.msg);
        };
        if (isPostgresJs) {
          // postgres.js: listen() resolves to a handle exposing unlisten().
          const sub = (await opts.client.listen!(channel, (payload) => handle(payload))) as
            | { unlisten?: () => unknown }
            | undefined;
          unlisten = sub?.unlisten;
        } else {
          // node-postgres: shared "notification" event; LISTEN does not block
          // the connection, so the same client also issues NOTIFY in publish().
          onNotification = (msg) => {
            if (msg.channel === channel && msg.payload !== undefined) {
              handle(msg.payload);
            }
          };
          opts.client.on!("notification", onNotification);
          await opts.client.query!(`LISTEN ${quotedChannel}`);
        }
      },
      async publish(msg) {
        const payload = encodeEnvelope(id, msg);
        if (isPostgresJs) {
          await opts.client.notify!(channel, payload);
        } else {
          // pg_notify takes the channel as text, sidestepping identifier quoting.
          await opts.client.query!("SELECT pg_notify($1, $2)", [channel, payload]);
        }
      },
      async close() {
        // Stop listening but leave the user-owned client connected.
        if (isPostgresJs) {
          await unlisten?.();
        } else if (onNotification) {
          // Only tear down if subscribe() actually ran (onNotification is set).
          opts.client.removeListener?.("notification", onNotification);
          onNotification = undefined;
          await opts.client.query?.(`UNLISTEN ${quotedChannel}`);
        }
      },
    };
  };
}
