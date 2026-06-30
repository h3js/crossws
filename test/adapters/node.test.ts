import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createServer, Server } from "node:http";
import { getRandomPort, waitForPort } from "get-port-please";
import nodeAdapter from "../../src/adapters/node";
import { defineHooks } from "../../src/index";
import { createDemo } from "../fixture/_shared";
import { wsTests } from "../tests";
import { wsConnect } from "../_utils";

describe("node", () => {
  let server: Server;
  let url: string;
  let ws: ReturnType<typeof createDemo<typeof nodeAdapter>>;

  beforeAll(async () => {
    ws = createDemo(nodeAdapter);
    server = createServer((req, res) => {
      if (req.url === "/peers") {
        return res.end(
          JSON.stringify({
            peers: [...ws.peers].flatMap(([namespace, peers]) =>
              [...peers].map((p) => `${namespace}:${p.id}`),
            ),
          }),
        );
      } else if (req.url!.startsWith("/publish")) {
        const q = new URLSearchParams(req.url!.split("?")[1]);
        const topic = q.get("topic") || "";
        const message = q.get("message") || "";
        if (topic && message) {
          ws.publish(topic, message);
          return res.end("published");
        }
      }
      res.end("ok");
    });
    server.on("upgrade", ws.handleUpgrade);
    const port = await getRandomPort("localhost");
    url = `ws://localhost:${port}/`;
    await new Promise<void>((resolve) => server.listen(port, resolve));
    await waitForPort(port);
  });

  afterAll(() => {
    ws.closeAll();
    server.close();
  });

  wsTests(() => url, {
    adapter: "node",
  });

  test("forcefully terminates when force=true", async () => {
    ws.closeAll(undefined, undefined, true);
    for (const [_ns, peers] of ws.peers) {
      for (const peer of peers) {
        expect(peer.websocket.readyState).toBe(2 /* CLOSING */);
      }
    }
  });
});

// Regression: `NodePeer._publish` derived `isBinary` from the raw payload, so a
// non-string value (a plain object, which `toBufferLike` serializes to a JSON
// string) was broadcast as a *binary* frame. The `_publish` fan-out path is only
// hit by subscribers other than the first (the first receives via `peer.send`,
// which was already correct), so the test needs two subscribers and asserts the
// second one receives a text frame.
describe("node (publish object frame type)", () => {
  let server: Server;
  let url: string;
  let ws: ReturnType<typeof nodeAdapter>;

  beforeAll(async () => {
    ws = nodeAdapter({
      hooks: defineHooks({
        open(peer) {
          peer.subscribe("room");
        },
      }),
    });
    server = createServer((_req, res) => res.end("ok"));
    server.on("upgrade", ws.handleUpgrade);
    const port = await getRandomPort("localhost");
    url = `ws://localhost:${port}/`;
    await new Promise<void>((resolve) => server.listen(port, resolve));
    await waitForPort(port);
  });

  afterAll(() => {
    ws.closeAll();
    server.close();
  });

  test("publishing a plain object delivers a text frame, not binary", async () => {
    const clientA = await wsConnect(url); // first subscriber -> receives via send()
    const clientB = await wsConnect(url); // later subscriber -> receives via _publish()
    // Let both open hooks subscribe to "room" before publishing.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Inspect the raw frame on B: a text frame arrives as a string, a binary
    // frame as an ArrayBuffer (wsConnect sets binaryType = "arraybuffer").
    const frame = new Promise<{ isString: boolean; data: unknown }>((resolve) => {
      clientB.ws.addEventListener("message", (event) => {
        resolve({ isString: typeof event.data === "string", data: event.data });
      });
    });
    void clientA;

    ws.publish("room", { hello: "world" });

    const received = await frame;
    expect(received.isString).toBe(true);
    expect(JSON.parse(received.data as string)).toEqual({ hello: "world" });
  });
});
