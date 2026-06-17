import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createServer, Server } from "node:http";
import { getRandomPort, waitForPort } from "get-port-please";
import { App, us_listen_socket_close } from "uWebSockets.js";
import nodeAdapter from "../../src/adapters/node";
import uwsAdapter from "../../src/adapters/uws";
import { defineHooks } from "../../src/index";
import { broadcastChannelSync } from "../../src/sync";
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
    const sync = broadcastChannelSync({ name: "crossws:test:sync" });
    [a, b] = await Promise.all([createInstance(sync), createInstance(sync)]);
  });

  afterAll(async () => {
    a.ws.closeAll();
    b.ws.closeAll();
    a.ws.sync?.close?.();
    b.ws.sync?.close?.();
    await Promise.all([a.close(), b.close()]);
  });

  test("peer.publish on one instance reaches a subscriber on another", async () => {
    const clientA = await wsConnect(a.url);
    const clientB = await wsConnect(b.url);

    await clientA.send("hello from A");

    // clientB is connected to instance B, yet receives the message relayed
    // from instance A through the sync backplane.
    expect(await clientB.next()).toBe("hello from A");
  });

  test("relay is bidirectional", async () => {
    const clientA = await wsConnect(a.url);
    const clientB = await wsConnect(b.url);

    await clientB.send("hello from B");
    expect(await clientA.next()).toBe("hello from B");
  });

  test("the publishing peer does not receive its own message back", async () => {
    const clientA = await wsConnect(a.url);
    const clientB = await wsConnect(b.url);

    await clientA.send("once");
    expect(await clientB.next()).toBe("once");

    // clientA must see "once" exactly zero times (self-exclusion holds across
    // the relay — the echo is suppressed by the driver's instance id).
    await clientB.send("twice");
    expect(await clientA.next()).toBe("twice");
    expect(clientA.messages).not.toContain("once");
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
  const token = await new Promise<unknown>((resolve, reject) => {
    app.listen(port, (listenSocket) => {
      listenSocket ? resolve(listenSocket) : reject(new Error("uWS listen failed"));
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
    const sync = broadcastChannelSync({ name: "crossws:test:uws-sync" });
    [a, b] = await Promise.all([createUwsInstance(sync), createUwsInstance(sync)]);
  });

  afterAll(() => {
    a.close();
    b.close();
    a.ws.sync?.close?.();
    b.ws.sync?.close?.();
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
