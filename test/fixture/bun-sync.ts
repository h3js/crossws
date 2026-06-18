// Self-contained Bun sync check, run via `bun run test/fixture/bun-sync.ts`
// (see test/adapters/bun.test.ts). Spins up two in-process Bun instances that
// share a BroadcastChannel backplane and asserts a publish on one instance
// reaches a subscriber connected to the other — exercising Bun's native
// server-side pub/sub through the sync layer. Exits non-zero on failure.

import bunAdapter from "../../src/adapters/bun";
import { defineHooks } from "../../src/index";
import { broadcastChannel } from "../../src/sync";

const hooks = defineHooks({
  open(peer) {
    peer.subscribe("chat");
  },
  message(peer, message) {
    peer.publish("chat", message.text());
  },
});

function createInstance(sync: ReturnType<typeof broadcastChannel>) {
  const ws = bunAdapter({ hooks, sync });
  const server = Bun.serve({
    port: 0, // random
    hostname: "localhost",
    websocket: ws.websocket,
    fetch: (request, server) => ws.handleUpgrade(request, server),
  });
  return { ws, url: `ws://localhost:${server.port}/chat`, stop: () => server.stop(true) };
}

function connect(url: string) {
  const ws = new WebSocket(url);
  const messages: string[] = [];
  const waiters: ((msg: string) => void)[] = [];
  ws.addEventListener("message", (event) => {
    const data = String(event.data);
    const waiter = waiters.shift();
    if (waiter) waiter(data);
    else messages.push(data);
  });
  return {
    ws,
    open: () => new Promise<void>((resolve) => ws.addEventListener("open", () => resolve())),
    send: (data: string) => ws.send(data),
    next: () =>
      new Promise<string>((resolve) => {
        const queued = messages.shift();
        if (queued !== undefined) resolve(queued);
        else waiters.push(resolve);
      }),
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms),
    ),
  ]);
}

const sync = broadcastChannel({ channel: "crossws:bun:sync" });
const a = createInstance(sync);
const b = createInstance(sync);

try {
  const clientA = connect(a.url);
  const clientB = connect(b.url);
  await Promise.all([clientA.open(), clientB.open()]);

  // publish on A reaches subscriber on B
  clientA.send("hello from A");
  const onB = await withTimeout(clientB.next(), 2000, "B to receive A's message");
  if (onB !== "hello from A") {
    throw new Error(`expected "hello from A" on B, got ${JSON.stringify(onB)}`);
  }

  // bidirectional + self-exclusion across the relay
  clientB.send("hello from B");
  const onA = await withTimeout(clientA.next(), 2000, "A to receive B's message");
  if (onA !== "hello from B") {
    throw new Error(`expected "hello from B" on A, got ${JSON.stringify(onA)}`);
  }

  console.log("bun sync ok");
  process.exit(0);
} catch (error) {
  console.error("bun sync failed:", (error as Error).message);
  process.exit(1);
} finally {
  a.stop();
  b.stop();
  sync({ id: "cleanup" }).close?.();
}
