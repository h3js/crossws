import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { request, type IncomingMessage } from "node:http";
import { connect } from "node:net";
import { getRandomPort, waitForPort } from "get-port-please";
import {
  App,
  us_listen_socket_close,
  type TemplatedApp,
  type us_listen_socket,
} from "uWebSockets.js";
import uwsAdapter from "../../src/adapters/uws";
import { defineHooks } from "../../src/index";
import { createDemo } from "../fixture/_shared";
import { wsTests, pingPongTests } from "../tests";
import { wsConnect } from "../_utils";

describe("uws", () => {
  let app: TemplatedApp;
  let url: string;

  beforeAll(async () => {
    const ws = createDemo(uwsAdapter);

    app = App().ws("/*", ws.websocket);

    app.get("/*", async (res, req) => {
      let aborted = false;
      res.onAborted(() => {
        aborted = true;
      });

      let resBody = "OK";
      const url = req.getUrl();
      if (url === "/peers") {
        resBody = JSON.stringify({
          peers: [...ws.peers].flatMap(([namespace, peers]) =>
            [...peers].map((p) => `${namespace}:${p.id}`),
          ),
        });
      } else if (url === "/publish") {
        const q = new URLSearchParams(req.getQuery());
        const topic = q.get("topic") || "";
        const message = q.get("message") || "";
        if (topic && message) {
          ws.publish(topic, message);
          resBody = "published";
        }
      }

      if (aborted) {
        return;
      }
      res.cork(() => {
        res.writeStatus("200 OK");
        res.end(resBody);
      });
    });

    const port = await getRandomPort("localhost");
    url = `ws://localhost:${port}/`;
    await new Promise<void>((resolve) => app.listen(port, () => resolve()));
    await waitForPort(port);
  });

  afterAll(() => {
    app.close();
  });

  wsTests(() => url, {
    adapter: "uws",
  });

  pingPongTests(() => url);
});

// uWS frames upgrade rejection responses itself and keeps the connection
// alive, so app framing headers must not be forwarded: `content-length` used
// to go out alongside uWS's `Transfer-Encoding: chunked`, which HTTP clients
// refuse to parse.
describe("uws (upgrade rejection response)", () => {
  let port: number;
  let close: () => void;

  beforeAll(async () => {
    const ws = uwsAdapter({
      hooks: defineHooks({
        upgrade(req) {
          const query = new URL(req.url).search;
          return new Response("unauthorized", {
            status: 401,
            headers:
              query === "?chunked"
                ? { "transfer-encoding": "chunked", "x-error": "unauthorized" }
                : { "content-length": "12", "x-error": "unauthorized" },
          });
        },
      }),
    });
    const app = App()
      .ws("/*", ws.websocket)
      .get("/*", (res) => {
        res.end("ok");
      });
    port = await getRandomPort("localhost");
    const token = await new Promise<us_listen_socket>((resolve, reject) => {
      app.listen(port, (listenSocket) =>
        listenSocket ? resolve(listenSocket) : reject(new Error("uWS listen failed")),
      );
    });
    await waitForPort(port);
    close = () => us_listen_socket_close(token);
  });

  afterAll(() => close());

  const upgradeHeaders = {
    connection: "Upgrade",
    upgrade: "websocket",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    "sec-websocket-version": "13",
  };

  test.each(["?content-length", "?chunked"])("parses with node:http (%s)", async (query) => {
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(`http://localhost:${port}/${query}`, {
        agent: false,
        headers: upgradeHeaders,
      });
      req.on("response", resolve);
      req.on("error", reject);
      req.end();
    });
    let body = "";
    for await (const chunk of res) body += chunk;
    expect(res.statusCode).toBe(401);
    expect(res.headers["x-error"]).toBe("unauthorized");
    expect(res.headers["content-length"]).toBe("12");
    expect(res.headers["transfer-encoding"]).toBeUndefined();
    expect(body).toBe("unauthorized");
  });

  test("uses a single framing header and keeps the connection usable", async () => {
    // Pipeline a plain request after the rejected upgrade on the same socket.
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, "localhost", () => {
        socket.write(
          [
            `GET /?content-length HTTP/1.1`,
            `host: localhost:${port}`,
            ...Object.entries(upgradeHeaders).map(([key, value]) => `${key}: ${value}`),
            "",
            `GET /next HTTP/1.1`,
            `host: localhost:${port}`,
          ].join("\r\n") + "\r\n\r\n",
        );
      });
      let data = "";
      socket.setEncoding("latin1");
      socket.on("data", (chunk) => {
        data += chunk;
        if (data.endsWith("\r\n\r\nok")) {
          socket.destroy();
          resolve(data);
        }
      });
      socket.on("error", reject);
    });
    const [head, rest] = raw.split("\r\n\r\n");
    const lines = head!.toLowerCase().split("\r\n");
    expect(lines[0]).toBe("http/1.1 401 ");
    expect(lines.filter((line) => line.startsWith("content-length:"))).toEqual([
      "content-length: 12",
    ]);
    expect(lines.some((line) => line.startsWith("transfer-encoding:"))).toBe(false);
    expect(rest).toMatch(/^unauthorizedHTTP\/1\.1 200 OK\r\n/);
  });
});

// Regression: a global `adapter.publish(topic, data)` (no namespace) on a
// native pub/sub adapter must reach each subscriber exactly once, even when
// subscribers live in different namespaces. uWS broadcasts a topic app-wide via
// a single `ws.publish`, so iterating every namespace Set (as the loop-based
// adapters require) used to deliver the message once per namespace.
describe("uws native global publish", () => {
  const hooks = defineHooks({
    open: (peer) => peer.subscribe("chat"),
  });

  let server: { ws: ReturnType<typeof uwsAdapter>; port: number; close: () => void };

  beforeAll(async () => {
    const ws = uwsAdapter({ hooks });
    const app = App().ws("/*", ws.websocket);
    const port = await getRandomPort("localhost");
    const token = await new Promise<us_listen_socket>((resolve, reject) => {
      app.listen(port, (listenSocket) =>
        listenSocket ? resolve(listenSocket) : reject(new Error("uWS listen failed")),
      );
    });
    await waitForPort(port);
    server = { ws, port, close: () => us_listen_socket_close(token) };
  });

  afterAll(() => server.close());

  test("global publish reaches each namespace's subscriber exactly once", async () => {
    // Two clients in distinct namespaces (derived from the URL pathname).
    const clientNs1 = await wsConnect(`ws://localhost:${server.port}/ns1`);
    const clientNs2 = await wsConnect(`ws://localhost:${server.port}/ns2`);
    // Let both `open` hooks run so each peer is subscribed before we publish.
    await new Promise((resolve) => setTimeout(resolve, 50));

    server.ws.publish("chat", "broadcast");

    expect(await clientNs1.next()).toBe("broadcast");
    expect(await clientNs2.next()).toBe("broadcast");

    // No duplicate delivery: before the fix each subscriber got one copy per
    // namespace (twice total). Settle, then assert exactly one each.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(clientNs1.messages).toEqual(["broadcast"]);
    expect(clientNs2.messages).toEqual(["broadcast"]);
  });
});
