import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createServer, Server } from "node:http";
import { getRandomPort, waitForPort } from "get-port-please";
import { App, us_listen_socket_close, type us_listen_socket } from "uWebSockets.js";
import nodeAdapter from "../../src/adapters/node";
import uwsAdapter from "../../src/adapters/uws";
import { defineHooks } from "../../src/index";
import { broadcastChannel } from "../../src/sync";
import type { SyncAdapter } from "../../src/sync";
import { wsConnect } from "../_utils";

// A chat-style server: every peer joins the "chat" channel on open and every
// message is re-broadcast to that channel. With a sync backplane configured,
// the broadcast must also reach subscribers connected to *other* instances.
const hooks = defineHooks({
  open(peer) {
    peer.subscribe("chat");
  },
  message(peer, message) {
    peer.publish("chat", message.text());
  },
});

async function createInstance(sync?: SyncAdapter) {
  const ws = nodeAdapter({ hooks, sync });
  const server: Server = createServer((_req, res) => res.end("ok"));
  server.on("upgrade", ws.handleUpgrade);
  const port = await getRandomPort("localhost");
  await new Promise<void>((resolve) => server.listen(port, resolve));
  await waitForPort(port);
  return {
    ws,
    url: `ws://localhost:${port}/chat`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("sync (broadcastChannel)", () => {
  let a: Awaited<ReturnType<typeof createInstance>>;
  let b: Awaited<ReturnType<typeof createInstance>>;

  beforeAll(async () => {
    // Both instances share a BroadcastChannel name → they form one cluster.
    const sync = broadcastChannel({ channel: "crossws:test:sync" });
    [a, b] = await Promise.all([createInstance(sync), createInstance(sync)]);
  });

  afterAll(async () => {
    // `ws.close()` closes peers and the sync backplane in one call.
    await Promise.all([a.ws.close(), b.ws.close()]);
    await Promise.all([a.close(), b.close()]);
  });

  test("relay is bidirectional and excludes the publisher", async () => {
    const clientA = await wsConnect(a.url);
    const clientB = await wsConnect(b.url);

    // A publish on instance A reaches the subscriber on instance B...
    await clientA.send("from A");
    expect(await clientB.next()).toBe("from A");

    // ...and the reverse direction works too.
    await clientB.send("from B");
    expect(await clientA.next()).toBe("from B");

    // Self-exclusion holds across the relay: the echo is suppressed by the
    // driver's instance id, so A never received its own "from A".
    expect(clientA.messages).not.toContain("from A");
  });
});

// uWebSockets uses native, server-side topic broadcast for `_publish` (unlike
// the plain JS-loop adapters). This exercises that path through the sync layer:
// inbound delivery fans out via the native `ws.publish`, and self-exclusion
// must still hold across the relay.
async function createUwsInstance(sync?: SyncAdapter) {
  const ws = uwsAdapter({ hooks, sync });
  const app = App().ws("/*", ws.websocket);
  const port = await getRandomPort("localhost");
  const token = await new Promise<us_listen_socket>((resolve, reject) => {
    app.listen(port, (listenSocket) => {
      return listenSocket ? resolve(listenSocket) : reject(new Error("uWS listen failed"));
    });
  });
  await waitForPort(port);
  return {
    ws,
    url: `ws://localhost:${port}/chat`,
    close: () => us_listen_socket_close(token),
  };
}

describe("sync (broadcastChannel + uWebSockets native pub/sub)", () => {
  let a: Awaited<ReturnType<typeof createUwsInstance>>;
  let b: Awaited<ReturnType<typeof createUwsInstance>>;

  beforeAll(async () => {
    const sync = broadcastChannel({ channel: "crossws:test:uws-sync" });
    [a, b] = await Promise.all([createUwsInstance(sync), createUwsInstance(sync)]);
  });

  afterAll(async () => {
    await Promise.all([a.ws.close(), b.ws.close()]);
    a.close();
    b.close();
  });

  test("native publish on one instance reaches a subscriber on another", async () => {
    const clientA = await wsConnect(a.url);
    const clientB = await wsConnect(b.url);

    await clientA.send("hello over uws");
    expect(await clientB.next()).toBe("hello over uws");

    // self-exclusion holds across the relay
    await clientB.send("back over uws");
    expect(await clientA.next()).toBe("back over uws");
    expect(clientA.messages).not.toContain("hello over uws");

    // No duplicate delivery on the receiving instance. clientB is the only
    // subscriber on instance B, so the inbound relay reaches it via the explicit
    // peer.send() and the native `ws.publish` must NOT *also* echo to it — that
    // would deliver the message twice. Settle, then assert exactly one copy.
    // (Guards against a uWS version where `ws.publish` echoes the sender socket.)
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(clientB.messages.filter((m) => m === "hello over uws")).toHaveLength(1);
    expect(clientA.messages.filter((m) => m === "back over uws")).toHaveLength(1);
  });
});

describe("sync (adapter close)", () => {
  test("close() closes connected peers and tears down the sync backplane", async () => {
    let syncClosed = false;
    const sync: SyncAdapter = () => ({
      subscribe() {},
      publish() {},
      close() {
        syncClosed = true;
      },
    });

    const inst = await createInstance(sync);
    try {
      const client = await wsConnect(inst.url);
      // Let the open hook run so the peer is registered on the server.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const peerCount = [...inst.ws.peers.values()].reduce((n, set) => n + set.size, 0);
      expect(peerCount).toBe(1);

      const closed = new Promise<number>((resolve) =>
        client.ws.addEventListener("close", (event) => resolve(event.code)),
      );

      await inst.ws.close(1000, "shutting down");

      // The peer's socket is closed (the client observes the close)...
      expect(await closed).toBe(1000);
      // ...and the backplane was released.
      expect(syncClosed).toBe(true);
    } finally {
      await inst.close();
    }
  });

  test("close() resolves even without a sync backplane", async () => {
    const inst = await createInstance();
    await wsConnect(inst.url);
    await expect(inst.ws.close()).resolves.toBeUndefined();
    await inst.close();
  });
});

describe("sync (no backplane)", () => {
  let a: Awaited<ReturnType<typeof createInstance>>;
  let b: Awaited<ReturnType<typeof createInstance>>;

  beforeAll(async () => {
    [a, b] = await Promise.all([createInstance(), createInstance()]);
  });

  afterAll(async () => {
    a.ws.closeAll();
    b.ws.closeAll();
    await Promise.all([a.close(), b.close()]);
  });

  test("without sync, a publish stays local to its instance", async () => {
    const clientA = await wsConnect(a.url);
    const clientB = await wsConnect(b.url);

    await clientA.send("local only");
    // Give any (nonexistent) relay a chance to arrive, then assert nothing did.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(clientB.messages).not.toContain("local only");
    expect(a.ws.sync).toBeUndefined();
  });
});
