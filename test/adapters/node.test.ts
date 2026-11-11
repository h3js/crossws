import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Agent, createServer, request, Server, type IncomingMessage } from "node:http";
import { connect } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { getRandomPort, waitForPort } from "get-port-please";
import nodeAdapter from "../../src/adapters/node";
import { defineHooks } from "../../src/index";
import { createDemo } from "../fixture/_shared";
import { wsTests, pingPongTests } from "../tests";
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

  pingPongTests(() => url);

  test("forcefully terminates when force=true", async () => {
    // Open a peer of our own so the assertion never depends on leftovers.
    await wsConnect(url);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const peers = [...ws.peers.values()].flatMap((peers) => [...peers]);
    expect(peers.length).toBeGreaterThan(0);
    ws.closeAll(undefined, undefined, true);
    for (const peer of peers) {
      expect(peer.websocket.readyState).toBe(2 /* CLOSING */);
    }
  });
});

// The socket is destroyed after an upgrade rejection, so the response must say
// `connection: close` or keep-alive clients pool the dead socket (#221). The
// body is close-delimited, so framing/keep-alive headers from the app are
// dropped, while other `connection` tokens are kept.
describe("node (upgrade rejection response)", () => {
  let server: Server;
  let port: number;
  let ws: ReturnType<typeof nodeAdapter>;

  beforeAll(async () => {
    ws = nodeAdapter({
      hooks: defineHooks({
        upgrade(req) {
          const query = new URL(req.url).search;
          if (query === "?keep-alive") {
            return new Response("unauthorized", {
              status: 401,
              headers: {
                "content-length": "12",
                connection: "keep-alive",
                "keep-alive": "timeout=5",
                "transfer-encoding": "chunked",
              },
            });
          }
          if (query === "?content-length") {
            return new Response("unauthorized", {
              status: 401,
              headers: { "content-length": "12" },
            });
          }
          if (query === "?upgrade-required") {
            return new Response("upgrade required", {
              status: 426,
              headers: { upgrade: "websocket", connection: "Upgrade" },
            });
          }
        },
      }),
    });
    server = createServer((_req, res) => res.end("ok"));
    server.on("upgrade", ws.handleUpgrade);
    port = await getRandomPort("localhost");
    await new Promise<void>((resolve) => server.listen(port, resolve));
    await waitForPort(port);
  });

  afterAll(async () => {
    await ws.close();
    server.close();
  });

  // Raw bytes of the response, read until the server closes the socket.
  const rawUpgrade = (path: string) =>
    new Promise<string>((resolve, reject) => {
      const socket = connect(port, "localhost", () => {
        socket.write(
          [
            `GET ${path} HTTP/1.1`,
            `host: localhost:${port}`,
            "connection: Upgrade",
            "upgrade: websocket",
            "sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==",
            "sec-websocket-version: 13",
          ].join("\r\n") + "\r\n\r\n",
        );
      });
      let data = "";
      socket.setEncoding("latin1");
      socket.on("data", (chunk) => (data += chunk));
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });

  const parseHead = (raw: string) => {
    const [head, body] = raw.split("\r\n\r\n");
    const [status, ...lines] = head!.split("\r\n");
    const headers = lines.map((line) => line.split(": ")[0]!.toLowerCase());
    const get = (name: string) =>
      lines
        .filter((line) => line.toLowerCase().startsWith(`${name}:`))
        .map((line) => line.slice(name.length + 1).trim());
    return { status, headers, get, body };
  };

  test("replaces app keep-alive headers with `connection: close`", async () => {
    const res = parseHead(await rawUpgrade("/?keep-alive"));
    expect(res.status).toBe("HTTP/1.1 401 ");
    expect(res.get("connection")).toEqual(["close"]);
    expect(res.headers).not.toContain("keep-alive");
    expect(res.headers).not.toContain("transfer-encoding");
    expect(res.get("content-length")).toEqual(["12"]);
    expect(res.body).toBe("unauthorized");
  });

  test("keeps other `connection` tokens", async () => {
    const res = parseHead(await rawUpgrade("/?upgrade-required"));
    expect(res.status).toBe("HTTP/1.1 426 ");
    expect(res.get("connection")).toEqual(["upgrade, close"]);
    expect(res.get("upgrade")).toEqual(["websocket"]);
  });

  // Before the fix the agent pooled the socket, and the next request failed
  // on it with "socket hang up".
  test("keep-alive agents do not reuse the socket", async () => {
    const agent = new Agent({ keepAlive: true });
    const sockets = new Set<unknown>();
    for (let i = 0; i < 3; i++) {
      const res = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = request(`http://localhost:${port}/?content-length`, {
          agent,
          headers: {
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
            "sec-websocket-version": "13",
          },
        });
        req.on("socket", (socket) => sockets.add(socket));
        req.on("response", (res) => res.resume().on("end", () => resolve(res)));
        req.on("error", reject);
        req.end();
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers.connection).toBe("close");
    }
    agent.destroy();
    expect(sockets.size).toBe(3);
  });
});

// Half-open connections (laptop sleep, NAT/mobile idle timeout, power loss)
// vanish without ever delivering a TCP FIN/RST, so `ws` never emits `'close'`
// and the peer leaks forever. The `idleTimeout` option pings peers and
// terminates any that miss the pong. Simulated here with an `autoPong: false`
// client that receives pings but never answers them.
describe("node (idleTimeout terminates unresponsive peers)", () => {
  let server: Server;
  let url: string;
  let ws: ReturnType<typeof nodeAdapter>;
  const closes: Array<{ code: number | undefined }> = [];

  beforeAll(async () => {
    ws = nodeAdapter({
      idleTimeout: 0.04, // seconds (40ms) — fast sweep for the test
      hooks: defineHooks({
        close(_peer, details) {
          closes.push({ code: details.code });
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

  afterAll(async () => {
    await ws.close();
    server.close();
  });

  test("terminates a peer that never answers pings", async () => {
    // A well-behaved client auto-pongs and must survive the heartbeat.
    const alive = new WebSocket(url);
    await new Promise((resolve) => alive.on("open", resolve));

    // A silent client never pongs -> the sweep must terminate it.
    const dead = new WebSocket(url, { autoPong: false });
    const deadClosed = new Promise<number>((resolve) => dead.on("close", (code) => resolve(code)));
    await new Promise((resolve) => dead.on("open", resolve));

    // First sweep marks not-alive + pings; second sweep (no pong seen)
    // terminates. Allow a few intervals of slack.
    const closeCode = await Promise.race([
      deadClosed,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("dead peer was not terminated")), 1000),
      ),
    ]);
    expect(closeCode).toBe(1006);
    expect(alive.readyState).toBe(WebSocket.OPEN);
    // The server-side `close` hook fires a tick after `terminate()` destroys the
    // socket — wait for it so downstream teardown (proxy upstream close) is
    // exercised through the normal path.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closes.some((c) => c.code === 1006)).toBe(true);

    alive.close();
  });
});

// Regression: with `clientTracking: false` (or a user-supplied `wss` created
// that way), `ws` leaves `wss.clients` `undefined`. The idle sweep — default-on
// since `idleTimeout` defaults to 30 — used to iterate `wss.clients` and threw
// `TypeError: undefined is not iterable` every tick. crossws now tracks its own
// sockets, so the sweep still detects and terminates dead peers without crashing.
describe("node (idleTimeout with clientTracking disabled)", () => {
  let server: Server;
  let url: string;
  let ws: ReturnType<typeof nodeAdapter>;

  beforeAll(async () => {
    ws = nodeAdapter({
      idleTimeout: 0.04, // seconds (40ms) — fast sweep for the test
      serverOptions: { clientTracking: false },
    });
    server = createServer((_req, res) => res.end("ok"));
    server.on("upgrade", ws.handleUpgrade);
    const port = await getRandomPort("localhost");
    url = `ws://localhost:${port}/`;
    await new Promise<void>((resolve) => server.listen(port, resolve));
    await waitForPort(port);
  });

  afterAll(async () => {
    await ws.close();
    server.close();
  });

  test("sweep terminates a silent peer without touching wss.clients", async () => {
    const dead = new WebSocket(url, { autoPong: false });
    const deadClosed = new Promise<number>((resolve) => dead.on("close", (code) => resolve(code)));
    await new Promise((resolve) => dead.on("open", resolve));

    const closeCode = await Promise.race([
      deadClosed,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("dead peer was not terminated")), 1000),
      ),
    ]);
    expect(closeCode).toBe(1006);
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

// `peer.request` must be the request the `upgrade` hook authorized (e.g. srvx's
// `NodeRequest` passed as `webRequest`), not a fresh proxy rebuilt from the raw
// `Host`/`req.url`, which would drop its URL semantics and any attached state.
describe("node (peer.request reuses the upgrade request)", () => {
  let server: Server;
  let url: string;
  let ws: ReturnType<typeof nodeAdapter>;
  const seen: { upgrade?: Request; open?: Request } = {};

  beforeAll(async () => {
    ws = nodeAdapter({
      hooks: defineHooks({
        upgrade(req) {
          seen.upgrade = req;
        },
        open(peer) {
          seen.open = peer.request;
        },
      }),
    });
    server = createServer((_req, res) => res.end("ok"));
    server.on("upgrade", (req, socket, head) => {
      const webRequest = new Request(`https://app.example.com${req.url}`, {
        headers: req.headers as Record<string, string>,
      });
      ws.handleUpgrade(req, socket, head, webRequest);
    });
    const port = await getRandomPort("localhost");
    url = `ws://localhost:${port}/room?x=1`;
    await new Promise<void>((resolve) => server.listen(port, resolve));
    await waitForPort(port);
  });

  afterAll(() => {
    ws.closeAll();
    server.close();
  });

  test("open hook sees the same request object as the upgrade hook", async () => {
    await wsConnect(url);
    await expect.poll(() => seen.open).toBeDefined();
    expect(seen.open).toBe(seen.upgrade);
    expect(seen.open!.url).toBe("https://app.example.com/room?x=1");
  });
});

// `permessage-deflate` is negotiated from `ws`'s server-wide options, so a
// per-connection `perMessageDeflate` returned by the `upgrade` hook overrides
// that option for the handshake only. The `ws` client offers the extension by
// default.
describe("node (per-connection perMessageDeflate)", () => {
  let server: Server;
  let url: string;
  let ws: ReturnType<typeof nodeAdapter>;
  const big = "x".repeat(64 * 1024);
  const small = "x".repeat(512);

  beforeAll(async () => {
    ws = nodeAdapter({
      hooks: defineHooks({
        upgrade(req) {
          const mode = new URL(req.url).searchParams.get("deflate");
          const headers = { "x-mode": mode || "default" };
          if (mode === "on") return { headers, perMessageDeflate: true };
          if (mode === "takeover") return { headers, perMessageDeflate: { threshold: 1024 } };
          if (mode === "no-takeover") {
            return {
              headers,
              perMessageDeflate: { serverNoContextTakeover: true, threshold: 1024 },
            };
          }
          if (mode === "tuned") {
            return { headers, perMessageDeflate: { serverNoContextTakeover: true, threshold: 0 } };
          }
          if (mode === "off") return { headers, perMessageDeflate: false };
          return { headers };
        },
        message(peer, message) {
          if (message.text() === "big") {
            peer.send(big);
          } else if (message.text() === "subscribe") {
            peer.subscribe("room");
            peer.send("subscribed");
          } else if (message.text() === "publish") {
            peer.publish("room", big);
          } else if (message.text() === "small") {
            peer.send(small);
          } else if (message.text() === "big-uncompressed") {
            peer.send(big, { compress: false });
          }
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

  afterAll(async () => {
    await ws.close();
    server.close();
  });

  const open = async (query: string) => {
    const client = new WebSocket(`${url}?${query}`);
    const upgradeHeaders = new Promise<Record<string, unknown>>((resolve) =>
      client.on("upgrade", (res) => resolve(res.headers)),
    );
    await new Promise((resolve, reject) => {
      client.on("open", resolve);
      client.on("error", reject);
    });
    return { client, headers: await upgradeHeaders };
  };

  // Bytes the client read off the wire to receive the reply to `command`.
  const wireBytes = async (client: WebSocket, command: string, expected = big) => {
    const socket = (client as unknown as { _socket: { bytesRead: number } })._socket;
    const before = socket.bytesRead;
    const reply = new Promise<string>((resolve) => client.once("message", (d) => resolve(`${d}`)));
    client.send(command);
    expect(await reply).toBe(expected);
    return socket.bytesRead - before;
  };

  test("disabled by default", async () => {
    const { client, headers } = await open("deflate=");
    expect(client.extensions).toBe("");
    expect(headers["x-mode"]).toBe("default");
    expect(await wireBytes(client, "big")).toBeGreaterThan(big.length);
    client.close();
  });

  test("negotiated and applied to sends when the hook returns `true`", async () => {
    const { client, headers } = await open("deflate=on");
    // The override is scoped to its own handshake.
    const { client: plain } = await open("deflate=");
    expect(plain.extensions).toBe("");
    plain.close();
    expect(client.extensions).toContain("permessage-deflate");
    expect(headers["x-mode"]).toBe("on");
    expect(await wireBytes(client, "big")).toBeLessThan(1024);
    expect(await wireBytes(client, "big-uncompressed")).toBeGreaterThan(big.length);
    client.close();
  });

  // `ws` only honors `threshold` without server context takeover; the docs rely
  // on this, so pin it down.
  test("`threshold` applies only with `serverNoContextTakeover`", async () => {
    const { client: takeover } = await open("deflate=takeover");
    expect(await wireBytes(takeover, "small", small)).toBeLessThan(small.length);
    takeover.close();

    const { client: noTakeover } = await open("deflate=no-takeover");
    expect(await wireBytes(noTakeover, "small", small)).toBeGreaterThan(small.length);
    expect(await wireBytes(noTakeover, "big")).toBeLessThan(1024);
    noTakeover.close();
  });

  test("accepts ws-style tuning options", async () => {
    for (let i = 0; i < 2; i++) {
      const { client, headers } = await open("deflate=tuned");
      expect(headers["sec-websocket-extensions"]).toContain("server_no_context_takeover");
      expect(await wireBytes(client, "big")).toBeLessThan(1024);
      client.close();
    }
  });

  test("publish fan-out is compressed too", async () => {
    // Two subscribers so delivery covers both `send()` and the `_publish` loop.
    const subscribers = await Promise.all([open("deflate=on"), open("deflate=on")]);
    for (const { client } of subscribers) {
      const ack = new Promise((resolve) => client.once("message", resolve));
      client.send("subscribe");
      await ack;
    }
    const sockets = subscribers.map(
      ({ client }) => (client as unknown as { _socket: { bytesRead: number } })._socket,
    );
    const before = sockets.map((s) => s.bytesRead);
    const received = subscribers.map(
      ({ client }) =>
        new Promise<string>((resolve) => client.once("message", (d) => resolve(`${d}`))),
    );
    ws.publish("room", big);
    expect(await Promise.all(received)).toEqual([big, big]);
    sockets.forEach((s, i) => expect(s.bytesRead - before[i]!).toBeLessThan(1024));
    for (const { client } of subscribers) client.close();
  });

  test("`false` refuses the extension even when enabled server-wide", async () => {
    const adapter = nodeAdapter({
      serverOptions: { perMessageDeflate: true },
      hooks: defineHooks({ upgrade: () => ({ perMessageDeflate: false }) }),
    });
    const srv = createServer((_req, res) => res.end("ok"));
    srv.on("upgrade", adapter.handleUpgrade);
    const port = await getRandomPort("localhost");
    await new Promise<void>((resolve) => srv.listen(port, resolve));
    const client = new WebSocket(`ws://localhost:${port}/`);
    await new Promise((resolve) => client.on("open", resolve));
    expect(client.extensions).toBe("");
    client.close();
    await adapter.close();
    srv.close();
  });

  test("keeps a user-supplied `wss`'s options, clients and lifecycle", async () => {
    let verified = 0;
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: 16,
      verifyClient: () => (verified++, true),
    });
    const adapter = nodeAdapter({
      wss: wss as any,
      hooks: defineHooks({ upgrade: () => ({ perMessageDeflate: true }) }),
    });
    const srv = createServer((_req, res) => res.end("ok"));
    srv.on("upgrade", adapter.handleUpgrade);
    const port = await getRandomPort("localhost");
    await new Promise<void>((resolve) => srv.listen(port, resolve));

    const client = new WebSocket(`ws://localhost:${port}/`);
    await new Promise((resolve) => client.on("open", resolve));
    expect(client.extensions).toContain("permessage-deflate");
    expect(verified).toBe(1);
    expect(wss.clients.size).toBe(1);
    expect(wss.options.perMessageDeflate).toBe(false);

    const closed = new Promise<number>((resolve) => client.on("close", resolve));
    client.send("x".repeat(64)); // over `maxPayload`
    expect(await closed).toBe(1009);

    // A closed server refuses new handshakes, compressed or not.
    wss.close();
    const refused = new WebSocket(`ws://localhost:${port}/`);
    const status = await new Promise<number>((resolve) =>
      refused.on("unexpected-response", (_req, res) => resolve(res.statusCode!)),
    );
    expect(status).toBe(503);

    await adapter.close();
    srv.close();
  });

  test("per-connection options keep the server's process-wide `concurrencyLimit`", async () => {
    // `verifyClient` runs synchronously inside the handshake, while the
    // per-connection override is applied.
    let seen: unknown;
    const wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: { concurrencyLimit: 4 },
      verifyClient: () => ((seen = wss.options.perMessageDeflate), true),
    });
    const adapter = nodeAdapter({
      wss: wss as any,
      hooks: defineHooks({ upgrade: () => ({ perMessageDeflate: { threshold: 0 } }) }),
    });
    const srv = createServer((_req, res) => res.end("ok"));
    srv.on("upgrade", adapter.handleUpgrade);
    const port = await getRandomPort("localhost");
    await new Promise<void>((resolve) => srv.listen(port, resolve));

    const client = new WebSocket(`ws://localhost:${port}/`);
    await new Promise((resolve) => client.on("open", resolve));
    expect(seen).toEqual({ threshold: 0, concurrencyLimit: 4 });
    expect(wss.options.perMessageDeflate).toEqual({ concurrencyLimit: 4 });

    client.close();
    await adapter.close();
    srv.close();
  });
});
