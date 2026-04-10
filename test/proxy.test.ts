import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createServer, Server } from "node:http";
import { getRandomPort, waitForPort } from "get-port-please";
import nodeAdapter from "../src/adapters/node.ts";
import { createWebSocketProxy, defineHooks } from "../src/index.ts";
import { _normalizeOutgoingCode, _remapIncomingCode } from "../src/proxy.ts";
import { wsConnect } from "./_utils.ts";

describe("createWebSocketProxy", () => {
  let upstreamServer: Server;
  let proxyServer: Server;
  let dynamicProxyServer: Server;
  let limitedProxyServer: Server;
  let badProxyServer: Server;
  let timeoutProxyServer: Server;
  let upstreamURL: string;
  let proxyURL: string;
  let dynamicProxyURL: string;
  let limitedProxyURL: string;
  let badProxyURL: string;
  let timeoutProxyURL: string;
  beforeAll(async () => {
    // Upstream echo server (crossws node adapter)
    const upstream = nodeAdapter({
      hooks: defineHooks({
        open(peer) {
          peer.send("welcome");
        },
        async upgrade(req) {
          const { pathname } = new URL(req.url);
          if (pathname === "/slow") {
            await new Promise((r) => setTimeout(r, 100));
          }
          if (req.headers.get("sec-websocket-protocol") === "chat") {
            return { headers: { "sec-websocket-protocol": "chat" } };
          }
        },
        message(peer, message) {
          const text = message.text();
          if (text === "getbinary") {
            peer.send(new TextEncoder().encode("binary-pong"));
            return;
          }
          if (text === "type") {
            const kind = typeof message.rawData === "string" ? "text" : "binary";
            peer.send(`type:${kind}`);
            return;
          }
          if (text.startsWith("close:")) {
            const [, codeStr, reason] = text.split(":");
            peer.close(Number(codeStr), reason);
            return;
          }
          peer.send(`echo:${text}`);
        },
      }),
    });
    upstreamServer = createServer((_req, res) => res.end("ok"));
    upstreamServer.on("upgrade", upstream.handleUpgrade);
    const upstreamPort = await getRandomPort("localhost");
    upstreamURL = `ws://localhost:${upstreamPort}/`;
    await new Promise<void>((resolve) => upstreamServer.listen(upstreamPort, resolve));
    await waitForPort(upstreamPort);

    // Proxy server using createWebSocketProxy hooks
    const proxy = nodeAdapter({
      hooks: createWebSocketProxy(upstreamURL),
    });
    proxyServer = createServer((_req, res) => res.end("ok"));
    proxyServer.on("upgrade", proxy.handleUpgrade);
    const proxyPort = await getRandomPort("localhost");
    proxyURL = `ws://localhost:${proxyPort}/`;
    await new Promise<void>((resolve) => proxyServer.listen(proxyPort, resolve));
    await waitForPort(proxyPort);

    // Proxy server using dynamic target function
    const dynamicProxy = nodeAdapter({
      hooks: createWebSocketProxy({ target: () => upstreamURL }),
    });
    dynamicProxyServer = createServer((_req, res) => res.end("ok"));
    dynamicProxyServer.on("upgrade", dynamicProxy.handleUpgrade);
    const dynamicProxyPort = await getRandomPort("localhost");
    dynamicProxyURL = `ws://localhost:${dynamicProxyPort}/`;
    await new Promise<void>((resolve) => dynamicProxyServer.listen(dynamicProxyPort, resolve));
    await waitForPort(dynamicProxyPort);

    // Proxy with a small buffer limit pointing at a slow-upgrade path
    const limitedProxy = nodeAdapter({
      hooks: createWebSocketProxy({
        target: `${upstreamURL}slow`,
        maxBufferSize: 5,
      }),
    });
    limitedProxyServer = createServer((_req, res) => res.end("ok"));
    limitedProxyServer.on("upgrade", limitedProxy.handleUpgrade);
    const limitedProxyPort = await getRandomPort("localhost");
    limitedProxyURL = `ws://localhost:${limitedProxyPort}/`;
    await new Promise<void>((resolve) => limitedProxyServer.listen(limitedProxyPort, resolve));
    await waitForPort(limitedProxyPort);

    // Proxy pointing at a port with nothing listening
    const deadPort = await getRandomPort("localhost");
    const badProxy = nodeAdapter({
      hooks: createWebSocketProxy(`ws://localhost:${deadPort}/`),
    });
    badProxyServer = createServer((_req, res) => res.end("ok"));
    badProxyServer.on("upgrade", badProxy.handleUpgrade);
    const badProxyPort = await getRandomPort("localhost");
    badProxyURL = `ws://localhost:${badProxyPort}/`;
    await new Promise<void>((resolve) => badProxyServer.listen(badProxyPort, resolve));
    await waitForPort(badProxyPort);

    // Proxy with a small connect timeout pointing at the slow-upgrade path
    const timeoutProxy = nodeAdapter({
      hooks: createWebSocketProxy({
        target: `${upstreamURL}slow`,
        connectTimeout: 25,
      }),
    });
    timeoutProxyServer = createServer((_req, res) => res.end("ok"));
    timeoutProxyServer.on("upgrade", timeoutProxy.handleUpgrade);
    const timeoutProxyPort = await getRandomPort("localhost");
    timeoutProxyURL = `ws://localhost:${timeoutProxyPort}/`;
    await new Promise<void>((resolve) => timeoutProxyServer.listen(timeoutProxyPort, resolve));
    await waitForPort(timeoutProxyPort);
  });

  afterAll(() => {
    for (const server of [
      proxyServer,
      dynamicProxyServer,
      limitedProxyServer,
      badProxyServer,
      timeoutProxyServer,
      upstreamServer,
    ]) {
      server.closeAllConnections?.();
      server.close();
    }
  });

  test("forwards welcome message from upstream", async () => {
    const ws = await wsConnect(proxyURL);
    expect(await ws.next()).toBe("welcome");
  });

  test("forwards text messages bidirectionally", async () => {
    const ws = await wsConnect(proxyURL, { skip: 1 });
    await ws.send("hello");
    expect(await ws.next()).toBe("echo:hello");
    await ws.send("world");
    expect(await ws.next()).toBe("echo:world");
  });

  test("forwards text frames as text (not binary)", async () => {
    // Regression: on Node's `ws` lib, text frames arrive as Buffer.
    // The Node adapter must decode them so downstream hooks see a string.
    const ws = await wsConnect(proxyURL, { skip: 1 });
    await ws.send("type");
    expect(await ws.next()).toBe("type:text");
  });

  test("forwards binary messages", async () => {
    const ws = await wsConnect(proxyURL, { skip: 1 });
    await ws.send("getbinary");
    // wsConnect decodes incoming binary frames as UTF-8 text
    expect(await ws.next()).toBe("binary-pong");
  });

  test("forwards subprotocol negotiation", async () => {
    const ws = await wsConnect(proxyURL, {
      headers: { "sec-websocket-protocol": "chat" },
    });
    expect(ws.inspector.headers).toMatchObject({
      "sec-websocket-protocol": "chat",
    });
  });

  test("buffers messages sent before upstream is open", async () => {
    // The client "open" event fires once the proxy handshake completes,
    // but the upstream WebSocket is still connecting inside the `open` hook,
    // so early messages must be buffered by the proxy.
    const ws = await wsConnect(proxyURL, { skip: 1 });
    await ws.send("early");
    expect(await ws.next()).toBe("echo:early");
  });

  test("accepts dynamic target function", async () => {
    const ws = await wsConnect(dynamicProxyURL, { skip: 1 });
    await ws.send("dyn");
    expect(await ws.next()).toBe("echo:dyn");
  });

  test("propagates upstream close code", async () => {
    const ws = await wsConnect(proxyURL, { skip: 1 });
    const closed = new Promise<CloseEvent>((resolve) => {
      ws.ws.addEventListener("close", (e) => resolve(e as CloseEvent));
    });
    await ws.send("close:4321:bye");
    const event = await closed;
    expect(event.code).toBe(4321);
  });

  test("closes peer with 1011 when upstream cannot connect", async () => {
    const ws = await wsConnect(badProxyURL);
    const event = await new Promise<CloseEvent>((resolve) => {
      ws.ws.addEventListener("close", (e) => resolve(e as CloseEvent));
    });
    expect(event.code).toBe(1011);
  });

  test("closes peer with 1011 when upstream handshake times out", async () => {
    // Upstream has a 100ms upgrade delay, proxy's connectTimeout is 25ms.
    const ws = await wsConnect(timeoutProxyURL);
    const event = await new Promise<CloseEvent>((resolve) => {
      ws.ws.addEventListener("close", (e) => resolve(e as CloseEvent));
    });
    expect(event.code).toBe(1011);
  });

  test("enforces maxBufferSize limit", async () => {
    const ws = await wsConnect(limitedProxyURL);
    const closed = new Promise<CloseEvent>((resolve) => {
      ws.ws.addEventListener("close", (e) => resolve(e as CloseEvent));
    });
    // Upstream has a 100ms upgrade delay, so these messages queue in the
    // proxy's buffer before the upstream connection opens. The proxy
    // accounts strings at their UTF-8 worst case (3 bytes per code unit)
    // so any non-empty frame exceeds the 5-byte limit configured above.
    await ws.send("aaaaa");
    const event = await closed;
    expect(event.code).toBe(1009);
  });
});

describe("createWebSocketProxy unit hooks", () => {
  test("echoes valid subprotocol tokens in upgrade response", () => {
    const hooks = createWebSocketProxy("ws://localhost/");
    const req = new Request("http://localhost/", {
      headers: { "sec-websocket-protocol": "chat" },
    });
    const result = hooks.upgrade?.(req);
    expect(result).toMatchObject({
      headers: { "sec-websocket-protocol": "chat" },
    });
  });

  test("drops subprotocol values that are not RFC 7230 tokens", () => {
    // Defense-in-depth: even if a buggy runtime lets a client smuggle a
    // non-token character into the header, the proxy must not echo it
    // into the upgrade response.
    const hooks = createWebSocketProxy("ws://localhost/");
    for (const bad of ["a/b", "has space", "semi;colon", "ctl\u0001"]) {
      const req = new Request("http://localhost/", {
        headers: { "sec-websocket-protocol": bad },
      });
      expect(hooks.upgrade?.(req)).toBeUndefined();
    }
  });

  test("passes headers option through to custom WebSocket constructor", () => {
    const calls: Array<{
      url: unknown;
      protocols: unknown;
      options: unknown;
    }> = [];
    class StubWS extends EventTarget {
      binaryType = "arraybuffer";
      readyState = 0;
      constructor(url: unknown, protocols: unknown, options?: unknown) {
        super();
        calls.push({ url, protocols, options });
      }
      send(): void {}
      close(): void {}
    }
    const hooks = createWebSocketProxy({
      target: "ws://upstream.invalid/",
      WebSocket: StubWS as unknown as typeof WebSocket,
      connectTimeout: 0,
      headers: (peer) => ({
        cookie: peer.request?.headers.get("cookie") ?? "",
        "x-trace": "t1",
      }),
    });
    const peer = {
      id: "p-headers",
      request: new Request("http://localhost/", {
        headers: { cookie: "sid=abc" },
      }),
      close() {},
      send() {},
    };
    hooks.open?.(peer as never);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toEqual({
      headers: { cookie: "sid=abc", "x-trace": "t1" },
    });
  });

  test("closes peer with 1011 when WebSocket constructor rejects the target", async () => {
    // The WHATWG `WebSocket` constructor throws `SyntaxError` for any
    // scheme other than `ws:`/`wss:`. The open hook must catch that
    // and close the peer instead of letting the exception escape.
    const badAdapter = nodeAdapter({
      hooks: createWebSocketProxy({
        target: () => new URL("http://localhost:1/"),
      }),
    });
    const server = createServer((_req, res) => res.end("ok"));
    server.on("upgrade", badAdapter.handleUpgrade);
    const port = await getRandomPort("localhost");
    await new Promise<void>((resolve) => server.listen(port, resolve));
    await waitForPort(port);
    try {
      const ws = await wsConnect(`ws://localhost:${port}/`);
      const event = await new Promise<CloseEvent>((resolve) => {
        ws.ws.addEventListener("close", (e) => resolve(e as CloseEvent));
      });
      expect(event.code).toBe(1011);
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });

  test("passes ws+unix targets through to a custom WebSocket client", () => {
    // No built-in scheme validation: anything the custom constructor
    // accepts (e.g. the `ws+unix:` syntax supported by `ws`) works.
    const calls: unknown[] = [];
    class StubWS extends EventTarget {
      binaryType = "arraybuffer";
      readyState = 0;
      constructor(url: unknown) {
        super();
        calls.push(url);
      }
      send(): void {}
      close(): void {}
    }
    const hooks = createWebSocketProxy({
      target: "ws+unix:/tmp/sock:/",
      WebSocket: StubWS as unknown as typeof WebSocket,
      connectTimeout: 0,
    });
    const peer = {
      id: "p-unix",
      request: new Request("http://localhost/"),
      close() {},
      send() {},
    };
    hooks.open?.(peer as never);
    expect(calls).toHaveLength(1);
    expect(String(calls[0])).toContain("ws+unix:");
  });
});

describe("createWebSocketProxy internals", () => {
  test("_normalizeOutgoingCode allows 1000 and 3000-4999 range", () => {
    // state.ws is a client-side WebSocket; WHATWG forbids anything else.
    expect(_normalizeOutgoingCode(undefined)).toBeUndefined();
    expect(_normalizeOutgoingCode(1000)).toBe(1000);
    expect(_normalizeOutgoingCode(3000)).toBe(3000);
    expect(_normalizeOutgoingCode(4999)).toBe(4999);
  });

  test("_normalizeOutgoingCode rewrites reserved and disallowed codes to 1000", () => {
    // Regression: state.ws.close(1005) would throw InvalidAccessError,
    // leaking the upstream socket. 1001/1008 are valid server-side codes
    // but still forbidden for client-side close(), so they also normalize.
    for (const code of [1001, 1005, 1006, 1008, 1011, 1015, 2999, 5000]) {
      expect(_normalizeOutgoingCode(code)).toBe(1000);
    }
  });

  test("_remapIncomingCode rewrites reserved pseudo-codes before peer close", () => {
    expect(_remapIncomingCode(undefined)).toBeUndefined();
    expect(_remapIncomingCode(1000)).toBe(1000);
    expect(_remapIncomingCode(1005)).toBe(1000);
    expect(_remapIncomingCode(1006)).toBe(1011);
    expect(_remapIncomingCode(1015)).toBe(1011);
    expect(_remapIncomingCode(4321)).toBe(4321);
  });
});
