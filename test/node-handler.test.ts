import { once } from "node:events";
import { getRandomPort } from "get-port-please";
import { afterEach, beforeEach, expect, test } from "vitest";
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import { fromNodeUpgradeHandler } from "../src/node-handler.ts";
import { serve } from "../src/server/node.ts";

type ServeReturn = ReturnType<typeof serve>;

let currentServer: ServeReturn | undefined;
let currentWss: WebSocketServer | undefined;
let unhandled: unknown[] = [];

function onUnhandled(err: unknown) {
  unhandled.push(err);
}

beforeEach(() => {
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
  process.on("uncaughtException", onUnhandled);
});

afterEach(async () => {
  process.off("unhandledRejection", onUnhandled);
  process.off("uncaughtException", onUnhandled);
  currentWss?.close();
  await currentServer?.close(true);
  currentServer = undefined;
  currentWss = undefined;
  // Give any stray async errors a tick to surface before asserting.
  await new Promise((r) => setImmediate(r));
  if (unhandled.length > 0) {
    throw new AggregateError(
      unhandled as Error[],
      `Unexpected unhandled errors during test: ${unhandled
        .map((e) => (e as Error)?.message ?? String(e))
        .join("; ")}`,
    );
  }
});

test("fromNodeUpgradeHandler delegates upgrade to a ws.WebSocketServer", async () => {
  const wss = new WebSocketServer({ noServer: true });
  currentWss = wss;
  const receivedOnUpstream: string[] = [];
  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      receivedOnUpstream.push(data.toString());
      ws.send(`echo:${data.toString()}`);
    });
  });

  const port = await getRandomPort("localhost");
  const server = serve({
    port,
    hostname: "127.0.0.1",
    fetch: () => new Response("ok"),
    websocket: fromNodeUpgradeHandler((req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    }),
  });
  currentServer = server;
  await server.ready();

  const client = new WebSocket(`ws://127.0.0.1:${port}/`);
  await once(client, "open");
  client.send("hello");
  const [reply] = await once(client, "message");
  expect(reply.toString()).toBe("echo:hello");
  expect(receivedOnUpstream).toEqual(["hello"]);
  client.close();
  await once(client, "close");
});

test("fromNodeUpgradeHandler does not invoke node adapter's own handleUpgrade", async () => {
  // If the handoff sentinel is ignored, the node adapter would try to run
  // ws.handleUpgrade on a socket that the user's handler has already taken
  // over — the client would see a connection failure or duplicate upgrade.
  // This test catches that regression by asserting the upstream handler is
  // the *only* thing that opens the WebSocket.
  const wss = new WebSocketServer({ noServer: true });
  currentWss = wss;
  let upstreamOpens = 0;
  wss.on("connection", (ws) => {
    upstreamOpens++;
    ws.on("message", (data) => ws.send(data));
  });

  const port = await getRandomPort("localhost");
  const server = serve({
    port,
    hostname: "127.0.0.1",
    fetch: () => new Response("ok"),
    websocket: fromNodeUpgradeHandler((req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    }),
  });
  currentServer = server;
  await server.ready();

  const client = new WebSocket(`ws://127.0.0.1:${port}/`);
  await once(client, "open");
  client.send("ping");
  const [reply] = await once(client, "message");
  expect(reply.toString()).toBe("ping");
  expect(upstreamOpens).toBe(1);
  client.close();
  await once(client, "close");
});
