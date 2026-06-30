import { describe, expect, test, vi } from "vitest";
import {
  cluster,
  decodeEnvelope,
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

// --- Cluster IPC mock ------------------------------------------------------

// Emulates the node:cluster topology: each worker has its own `process`-like
// object that can only `send()` to the primary, and the primary (the hub)
// rebroadcasts every relay message to all workers — exactly what
// setupPrimaryCluster() installs. Workers never talk to each other directly.
interface FakeProc {
  send(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): void;
  off(event: "message", listener: (message: unknown) => void): void;
}

class ClusterHub {
  private workers: { deliver(message: unknown): void }[] = [];

  fork(): FakeProc {
    const listeners = new Set<(message: unknown) => void>();
    this.workers.push({
      deliver: (message) => {
        for (const listener of listeners) {
          listener(message);
        }
      },
    });
    return {
      // worker → primary → rebroadcast to all workers (incl. sender)
      send: (message) => {
        for (const worker of this.workers) {
          worker.deliver(message);
        }
      },
      on: (_event, listener) => listeners.add(listener),
      off: (_event, listener) => listeners.delete(listener),
    };
  }
}

// Instantiate a cluster driver as if running inside a forked worker: the driver
// captures `globalThis.process` at construction, so swap in the fake worker
// process just for that call, then restore it.
function clusterWorker(channel: string, hub: ClusterHub, id: string) {
  const real = globalThis.process;
  globalThis.process = hub.fork() as unknown as typeof globalThis.process;
  try {
    return cluster({ channel })({ id });
  } finally {
    globalThis.process = real;
  }
}

describe("sync (cluster, node:cluster IPC)", () => {
  async function relayPair(channel = "crossws:test") {
    const hub = new ClusterHub();
    const a = clusterWorker(channel, hub, "a");
    const b = clusterWorker(channel, hub, "b");
    const onA: SyncMessage[] = [];
    const onB: SyncMessage[] = [];
    await a.subscribe((m) => onA.push(m));
    await b.subscribe((m) => onB.push(m));
    return { a, b, onA, onB };
  }

  test("publish on one worker reaches the other, not itself", async () => {
    const { a, onA, onB } = await relayPair();

    await a.publish({ namespace: "", topic: "chat", data: "hello" });

    expect(onB).toEqual([{ namespace: "", topic: "chat", data: "hello" }]);
    expect(onA).toEqual([]); // echo suppressed by instance id
  });

  test("relay is bidirectional and binary survives JSON IPC", async () => {
    const { a, b, onA, onB } = await relayPair();
    const data = new Uint8Array([0, 1, 2, 254, 255]);

    await a.publish({ namespace: "ns", topic: "t", data });
    await b.publish({ namespace: "ns", topic: "t", data: "from-b" });

    expect(onA).toEqual([{ namespace: "ns", topic: "t", data: "from-b" }]);
    expect(onB).toHaveLength(1);
    expect([...(onB[0]!.data as Uint8Array)]).toEqual([...data]);
  });

  test("a foreign channel on the same process tree does not bridge", async () => {
    const hub = new ClusterHub();
    const a = clusterWorker("chan-a", hub, "a");
    const b = clusterWorker("chan-b", hub, "b");
    const onB: SyncMessage[] = [];
    await b.subscribe((m) => onB.push(m));

    await a.publish({ namespace: "", topic: "t", data: "x" });

    expect(onB).toEqual([]);
  });

  test("subscribe throws when not running in a forked worker", async () => {
    const real = globalThis.process;
    // A primary / standalone process has no `send`.
    globalThis.process = { on() {}, off() {} } as unknown as typeof globalThis.process;
    try {
      const driver = cluster({ channel: "my-app" })({ id: "a" });
      expect(() => driver.subscribe(() => {})).toThrow(/worker forked by node:cluster/);
    } finally {
      globalThis.process = real;
    }
  });
});

describe("sync (driver guards)", () => {
  test("pgsql rejects a pg Pool (rotating connections break LISTEN)", () => {
    // A Pool is structurally a Client (query/on) but exposes pool-only counters.
    const pool = {
      query: () => {},
      on: () => {},
      idleCount: 0,
      totalCount: 0,
      waitingCount: 0,
    } as unknown as PostgresClientLike;
    expect(() => pgsql({ client: pool, channel: "my-app" })).toThrow(/dedicated `Client`/);
  });

  test("pgsql accepts a plain Client (no pool counters)", () => {
    const client: PostgresClientLike = { query: () => {}, on: () => {} };
    expect(() => pgsql({ client, channel: "my-app" })).not.toThrow();
  });

  test("pgsql rejects a channel name longer than 63 bytes", () => {
    const client: PostgresClientLike = { query: () => {}, on: () => {} };
    expect(() => pgsql({ client, channel: "x".repeat(64) })).toThrow(/at most 63 bytes/);
    expect(() => pgsql({ client, channel: "x".repeat(63) })).not.toThrow();
  });

  test("redis publish rejection is isolated (driver publish rejects, not the caller)", async () => {
    // The relay is fire-and-forget at the call sites (peer/adapter); the driver's
    // publish itself still rejects on a failing client — assert that surfaces as a
    // rejection the callers can catch rather than swallow silently here.
    const client: RedisClientLike = {
      duplicate: () => client,
      publish: () => {
        throw new Error("connection lost");
      },
      subscribe: () => {},
      on: () => {},
    };
    const driver = redis({ client, channel: "my-app" })({ id: "a" });
    await expect(driver.publish({ namespace: "", topic: "t", data: "x" })).rejects.toThrow(
      "connection lost",
    );
  });

  test("redis close before subscribe does not quit an unconnected subscriber", async () => {
    const quit = vi.fn();
    const client = {
      pSubscribe: () => {}, // node-redis flavor
      duplicate: () => ({
        connect: () => {},
        subscribe: () => {},
        quit,
      }),
      publish: () => {},
      subscribe: () => {},
    } as unknown as RedisClientLike;
    const driver = redis({ client, channel: "my-app" })({ id: "a" });
    // Never subscribed → close must be a no-op (quit on an unconnected node-redis
    // client throws), so this must not reject and must not call quit().
    await expect(driver.close?.()).resolves.toBeUndefined();
    expect(quit).not.toHaveBeenCalled();
  });
});

describe("sync (envelope decoding)", () => {
  test("decodeEnvelope rejects malformed / partial payloads", () => {
    expect(decodeEnvelope("not json")).toBeUndefined();
    expect(decodeEnvelope("123")).toBeUndefined();
    expect(decodeEnvelope("null")).toBeUndefined();
    expect(decodeEnvelope("{}")).toBeUndefined();
    expect(decodeEnvelope(JSON.stringify({ id: "a", msg: {} }))).toBeUndefined();
    // foreign object missing topic/namespace
    expect(decodeEnvelope(JSON.stringify({ id: "a", msg: { topic: "t" } }))).toBeUndefined();
    // non-string `data` must be rejected (a foreign producer can't leak an
    // object/null through as SyncMessage.data)
    expect(
      decodeEnvelope(JSON.stringify({ id: "a", msg: { namespace: "", topic: "t", data: {} } })),
    ).toBeUndefined();
    expect(
      decodeEnvelope(JSON.stringify({ id: "a", msg: { namespace: "", topic: "t" } })),
    ).toBeUndefined();
  });

  test("decodeEnvelope accepts a well-formed envelope", () => {
    const raw = JSON.stringify({ id: "a", msg: { namespace: "", topic: "t", data: "x" } });
    expect(decodeEnvelope(raw)).toEqual({ id: "a", msg: { namespace: "", topic: "t", data: "x" } });
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
