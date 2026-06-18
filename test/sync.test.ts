import { describe, expect, test } from "vitest";
import {
  pgsql,
  redis,
  type PostgresClientLike,
  type RedisClientLike,
  type SyncAdapter,
  type SyncMessage,
} from "../src/sync";

// An in-memory stand-in for a pub/sub server (Redis pub/sub or Postgres
// LISTEN/NOTIFY — both are just `channel → listeners`). Every mock client below
// routes through a shared broker instance, so two drivers pointed at the same
// broker behave like two crossws instances sharing one backend.
class Broker {
  private listeners = new Map<string, Set<(payload: string) => void>>();

  subscribe(channel: string, listener: (payload: string) => void): void {
    let set = this.listeners.get(channel);
    if (!set) {
      this.listeners.set(channel, (set = new Set()));
    }
    set.add(listener);
  }

  unsubscribe(channel: string, listener: (payload: string) => void): void {
    this.listeners.get(channel)?.delete(listener);
  }

  publish(channel: string, payload: string): void {
    for (const listener of this.listeners.get(channel) ?? []) {
      listener(payload);
    }
  }
}

// --- Redis client mocks ----------------------------------------------------

// ioredis shape: `subscribe(channel)` + a shared "message" event whose listener
// receives `(channel, message)`; `duplicate()` returns a ready client.
function ioredisMock(broker: Broker): RedisClientLike {
  const handlers = new Set<(channel: string, message: string) => void>();
  return {
    duplicate: () => ioredisMock(broker),
    publish: (channel, message) => broker.publish(channel, message),
    on: (_event, listener) => handlers.add(listener),
    subscribe: (channel) =>
      broker.subscribe(channel, (message) => {
        for (const handler of handlers) {
          handler(channel, message);
        }
      }),
    // no pSubscribe → auto-detected as ioredis
  };
}

// node-redis shape: `subscribe(channel, listener)` with an inline listener that
// receives `(message, channel)`; `duplicate()` returns a disconnected client.
function nodeRedisMock(broker: Broker): RedisClientLike & { connected: boolean } {
  return {
    connected: false,
    pSubscribe: () => {}, // camelCase marker → auto-detected as node-redis
    duplicate() {
      return nodeRedisMock(broker);
    },
    connect() {
      this.connected = true;
    },
    quit() {
      this.connected = false;
    },
    publish: (channel, message) => broker.publish(channel, message),
    subscribe(channel, listener) {
      if (!this.connected) {
        throw new Error("node-redis: subscribe before connect()");
      }
      broker.subscribe(channel, (message) => listener?.(message, channel));
    },
  };
}

// --- Postgres client mocks -------------------------------------------------

// node-postgres (pg) shape: raw `LISTEN`/`pg_notify` via `query()` plus a shared
// "notification" event whose listener receives `{ channel, payload }`.
function pgMock(broker: Broker): PostgresClientLike {
  const handlers = new Set<(msg: { channel: string; payload?: string }) => void>();
  // Track per-channel broker subscriptions so UNLISTEN can detach them.
  const subs = new Map<string, (payload: string) => void>();
  const parseChannel = (sql: string) =>
    sql.replace(/^(?:LISTEN|UNLISTEN)\s+"(.*)"$/, "$1").replace(/""/g, '"');
  return {
    on: (_event, listener) => handlers.add(listener),
    query(sql: string, values?: unknown[]) {
      if (sql === "SELECT pg_notify($1, $2)") {
        const [channel, payload] = values as [string, string];
        broker.publish(channel, payload);
      } else if (sql.startsWith("LISTEN ")) {
        const channel = parseChannel(sql);
        const sub = (payload: string) => {
          for (const handler of handlers) {
            handler({ channel, payload });
          }
        };
        subs.set(channel, sub);
        broker.subscribe(channel, sub);
      } else if (sql.startsWith("UNLISTEN ")) {
        const channel = parseChannel(sql);
        const sub = subs.get(channel);
        if (sub) {
          broker.unsubscribe(channel, sub);
        }
      }
    },
    // no listen() → auto-detected as node-postgres
  };
}

// postgres.js shape: dedicated `listen(channel, onnotify)` resolving to a handle
// with `unlisten()`, plus `notify(channel, payload)`.
function postgresJsMock(broker: Broker): PostgresClientLike {
  return {
    listen(channel, onnotify) {
      broker.subscribe(channel, onnotify);
      return Promise.resolve({
        unlisten: () => broker.unsubscribe(channel, onnotify),
      });
    },
    notify: (channel, payload) => broker.publish(channel, payload),
  };
}

// Wire two drivers (distinct instance ids) to one broker and collect what each
// delivers, then run the same relay assertions against any client flavor. Each
// instance gets its own client (separate processes share only the backend), so
// the broker is the single shared "database"/"server".
async function relayPair(
  makeAdapter: (broker: Broker, channel: string) => SyncAdapter,
  channel = "crossws:test",
) {
  const broker = new Broker();
  const a = makeAdapter(broker, channel)({ id: "a" });
  const b = makeAdapter(broker, channel)({ id: "b" });
  const onA: SyncMessage[] = [];
  const onB: SyncMessage[] = [];
  await a.subscribe((m) => onA.push(m));
  await b.subscribe((m) => onB.push(m));
  return { a, b, onA, onB };
}

describe.each([
  [
    "redis, ioredis client",
    (broker: Broker, channel: string) => redis({ client: ioredisMock(broker), channel }),
  ],
  [
    "redis, node-redis client",
    (broker: Broker, channel: string) => redis({ client: nodeRedisMock(broker), channel }),
  ],
  [
    "postgres, node-postgres client",
    (broker: Broker, channel: string) => pgsql({ client: pgMock(broker), channel }),
  ],
  [
    "postgres, postgres.js client",
    (broker: Broker, channel: string) => pgsql({ client: postgresJsMock(broker), channel }),
  ],
])("sync (%s)", (_name, makeAdapter) => {
  test("publish on one instance reaches the other, not itself", async () => {
    const { a, onA, onB } = await relayPair(makeAdapter);

    await a.publish({ namespace: "", topic: "chat", data: "hello" });

    expect(onB).toEqual([{ namespace: "", topic: "chat", data: "hello" }]);
    expect(onA).toEqual([]); // echo suppressed by instance id
  });

  test("relay is bidirectional", async () => {
    const { a, b, onA, onB } = await relayPair(makeAdapter);

    await a.publish({ namespace: "ns", topic: "t", data: "from-a" });
    await b.publish({ namespace: "ns", topic: "t", data: "from-b" });

    expect(onA).toEqual([{ namespace: "ns", topic: "t", data: "from-b" }]);
    expect(onB).toEqual([{ namespace: "ns", topic: "t", data: "from-a" }]);
  });

  test("binary payloads survive the text transport", async () => {
    const { a, onB } = await relayPair(makeAdapter);
    const data = new Uint8Array([0, 1, 2, 254, 255]);

    await a.publish({ namespace: "", topic: "bin", data });

    expect(onB).toHaveLength(1);
    expect(onB[0]!.data).toBeInstanceOf(Uint8Array);
    expect([...(onB[0]!.data as Uint8Array)]).toEqual([...data]);
  });
});

describe("sync (redis, connector escape hatch)", () => {
  test("connector overrides auto-detection", async () => {
    // node-redis client (has pSubscribe) but forced down the ioredis path: the
    // explicit connector wins, so subscribe must use the `.on("message")` shape.
    const broker = new Broker();
    const usedMessageEvent = { value: false };
    const client: RedisClientLike = {
      pSubscribe: () => {},
      duplicate: () => client,
      publish: (channel, message) => broker.publish(channel, message),
      on: (_event, listener) => {
        usedMessageEvent.value = true;
        broker.subscribe("crossws:test", (message) => listener("crossws:test", message));
        return undefined;
      },
      subscribe: () => {},
    };

    const adapter = redis({ client, channel: "crossws:test", connector: "ioredis" });
    const onA: SyncMessage[] = [];
    await adapter({ id: "a" }).subscribe((m) => onA.push(m));
    await adapter({ id: "b" }).publish({ namespace: "", topic: "t", data: "x" });

    expect(usedMessageEvent.value).toBe(true);
    expect(onA).toEqual([{ namespace: "", topic: "t", data: "x" }]);
  });

  test("node-redis subscriber is connected before subscribe and quit on close", async () => {
    const broker = new Broker();
    const client = nodeRedisMock(broker);
    // Track the duplicated subscriber so we can assert its lifecycle.
    let subscriber!: ReturnType<typeof nodeRedisMock>;
    const original = client.duplicate.bind(client);
    client.duplicate = () => (subscriber = original() as ReturnType<typeof nodeRedisMock>);

    const driver = redis({ client, channel: "crossws:test" })({ id: "a" });
    await driver.subscribe(() => {});
    expect(subscriber.connected).toBe(true);

    await driver.close?.();
    expect(subscriber.connected).toBe(false);
  });
});

describe("sync (postgres, connector escape hatch)", () => {
  test("connector overrides auto-detection", async () => {
    // postgres.js client (has listen()) but forced down the node-postgres path:
    // the explicit connector wins, so subscribe must use query()/"notification".
    const broker = new Broker();
    const usedQuery = { value: false };
    const handlers = new Set<(msg: { channel: string; payload?: string }) => void>();
    const client: PostgresClientLike = {
      listen: () => Promise.resolve({ unlisten: () => {} }),
      notify: () => {},
      on: (_event, listener) => handlers.add(listener),
      query(sql: string, values?: unknown[]) {
        usedQuery.value = true;
        if (sql === "SELECT pg_notify($1, $2)") {
          const [channel, payload] = values as [string, string];
          broker.publish(channel, payload);
        } else if (sql.startsWith("LISTEN ")) {
          broker.subscribe("crossws:test", (payload) => {
            for (const handler of handlers) {
              handler({ channel: "crossws:test", payload });
            }
          });
        }
      },
    };

    const adapter = pgsql({ client, channel: "crossws:test", connector: "pg" });
    const onA: SyncMessage[] = [];
    await adapter({ id: "a" }).subscribe((m) => onA.push(m));
    await adapter({ id: "b" }).publish({ namespace: "", topic: "t", data: "x" });

    expect(usedQuery.value).toBe(true);
    expect(onA).toEqual([{ namespace: "", topic: "t", data: "x" }]);
  });

  test("postgres.js subscriber is unlistened on close", async () => {
    const broker = new Broker();
    let unlistened = false;
    const client: PostgresClientLike = {
      listen(channel, onnotify) {
        broker.subscribe(channel, onnotify);
        return Promise.resolve({
          unlisten: () => {
            unlistened = true;
            broker.unsubscribe(channel, onnotify);
          },
        });
      },
      notify: (channel, payload) => broker.publish(channel, payload),
    };

    const driver = pgsql({ client, channel: "crossws:test" })({ id: "a" });
    await driver.subscribe(() => {});
    await driver.close?.();

    expect(unlistened).toBe(true);
  });
});
