import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createServer, Server } from "node:http";
import { getRandomPort, waitForPort } from "get-port-please";
import nodeAdapter from "../../src/adapters/node";
import { createDemo } from "../fixture/_shared";
import { wsTests } from "../tests";

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
