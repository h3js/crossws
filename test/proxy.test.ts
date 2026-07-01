import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createServer, Server } from "node:http";
import { existsSync, unlinkSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRandomPort, waitForPort } from "get-port-please";
import { WebSocket as WsWebSocket } from "ws";
import nodeAdapter from "../src/adapters/node.ts";
import { createWebSocketProxy, defineHooks } from "../src/index.ts";
import {
  _normalizeOutgoingCode,
  _parseUnixTarget,
  _remapIncomingCode,
  _resolveProtocols,
} from "../src/proxy.ts";
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

  test("accepts an async (promise-returning) target resolver", async () => {
    // The upstream address may not be known when the client connects (e.g. a
    // worker that's still booting). An async resolver lets the proxy wait.
    const asyncProxy = nodeAdapter({
      hooks: createWebSocketProxy({
        target: async () => {
          await new Promise((r) => setTimeout(r, 50));
          return upstreamURL;
        },
      }),
    });
    const server = createServer((_req, res) => res.end("ok"));
    server.on("upgrade", asyncProxy.handleUpgrade);
    const port = await getRandomPort("localhost");
    await new Promise<void>((resolve) => server.listen(port, resolve));
    await waitForPort(port);
    try {
      // Frames sent before the async target resolves must be buffered and
      // flushed once the upstream opens.
      const ws = await wsConnect(`ws://localhost:${port}/`, { skip: 1 });
      await ws.send("early");
      expect(await ws.next()).toBe("echo:early");
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });

  test("accepts a non-native thenable target resolver", async () => {
    // Resolvers backed by non-native promises (Bluebird, cross-realm, custom
    // thenables from RPC clients) must be awaited like any other promise — not
    // stringified into `new URL()`.
    const thenableProxy = nodeAdapter({
      hooks: createWebSocketProxy({
        target: () =>
          ({
            // oxlint-disable-next-line unicorn/no-thenable -- intentionally a non-native thenable
            then(onFulfilled: (value: string) => void) {
              setTimeout(() => onFulfilled(upstreamURL), 50);
            },
          }) as unknown as Promise<string>,
      }),
    });
    const server = createServer((_req, res) => res.end("ok"));
    server.on("upgrade", thenableProxy.handleUpgrade);
    const port = await getRandomPort("localhost");
    await new Promise<void>((resolve) => server.listen(port, resolve));
    await waitForPort(port);
    try {
      const ws = await wsConnect(`ws://localhost:${port}/`, { skip: 1 });
      await ws.send("early");
      expect(await ws.next()).toBe("echo:early");
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });

  test("closes peer with 1011 when an async target resolver rejects", async () => {
    const rejectProxy = nodeAdapter({
      hooks: createWebSocketProxy({
        target: async () => {
          throw new Error("worker never came up");
        },
      }),
    });
    const server = createServer((_req, res) => res.end("ok"));
    server.on("upgrade", rejectProxy.handleUpgrade);
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

  test("proxies to a unix-socket upstream out of the box (no custom WebSocket)", async () => {
    // A `ws+unix://<socketPath>:<pathname>` target works without any custom
    // `WebSocket` constructor: the proxy picks the right per-runtime dialing
    // strategy internally. On this Node test runner that means a lazy
    // `import("ws")` (Node's global undici WebSocket rejects the scheme).
    const socketPath = join(tmpdir(), `crossws-proxy-unix-${process.pid}.sock`);
    if (existsSync(socketPath)) unlinkSync(socketPath);

    // Upstream echo server bound to the unix socket instead of a TCP port.
    const unixUpstream = nodeAdapter({
      hooks: defineHooks({
        message(peer, message) {
          peer.send(`echo:${message.text()}`);
        },
      }),
    });
    const unixUpstreamServer = createServer((_req, res) => res.end("ok"));
    unixUpstreamServer.on("upgrade", unixUpstream.handleUpgrade);
    await new Promise<void>((resolve) => unixUpstreamServer.listen(socketPath, resolve));

    // No `WebSocket` option — the proxy resolves the dialer per runtime.
    const unixProxy = nodeAdapter({
      hooks: createWebSocketProxy({
        target: `ws+unix://${socketPath}:/chat`,
      }),
    });
    const server = createServer((_req, res) => res.end("ok"));
    server.on("upgrade", unixProxy.handleUpgrade);
    const port = await getRandomPort("localhost");
    await new Promise<void>((resolve) => server.listen(port, resolve));
    await waitForPort(port);
    try {
      const ws = await wsConnect(`ws://localhost:${port}/`);
      await ws.send("unix");
      expect(await ws.next()).toBe("echo:unix");
    } finally {
      server.closeAllConnections?.();
      server.close();
      unixUpstreamServer.closeAllConnections?.();
      unixUpstreamServer.close();
      if (existsSync(socketPath)) unlinkSync(socketPath);
    }
  });

  test("proxies to a unix-socket upstream with an explicit ws WebSocket", async () => {
    // An explicit `WebSocket` constructor is honored verbatim (bypassing the
    // per-runtime strategy) — the `ws` client dials `ws+unix:` directly.
    const socketPath = join(tmpdir(), `crossws-proxy-unix-explicit-${process.pid}.sock`);
    if (existsSync(socketPath)) unlinkSync(socketPath);

    const unixUpstream = nodeAdapter({
      hooks: defineHooks({
        message(peer, message) {
          peer.send(`echo:${message.text()}`);
        },
      }),
    });
    const unixUpstreamServer = createServer((_req, res) => res.end("ok"));
    unixUpstreamServer.on("upgrade", unixUpstream.handleUpgrade);
    await new Promise<void>((resolve) => unixUpstreamServer.listen(socketPath, resolve));

    const unixProxy = nodeAdapter({
      hooks: createWebSocketProxy({
        target: `ws+unix://${socketPath}:/`,
        WebSocket: WsWebSocket as unknown as typeof WebSocket,
      }),
    });
    const server = createServer((_req, res) => res.end("ok"));
    server.on("upgrade", unixProxy.handleUpgrade);
    const port = await getRandomPort("localhost");
    await new Promise<void>((resolve) => server.listen(port, resolve));
    await waitForPort(port);
    try {
      const ws = await wsConnect(`ws://localhost:${port}/`);
      await ws.send("unix");
      expect(await ws.next()).toBe("echo:unix");
    } finally {
      server.closeAllConnections?.();
      server.close();
      unixUpstreamServer.closeAllConnections?.();
      unixUpstreamServer.close();
      if (existsSync(socketPath)) unlinkSync(socketPath);
    }
  });

  test("dials a unix socket via a webSocketOptions transport override", async () => {
    // Some runtimes (Deno) reject the `ws+unix:` scheme and can only reach a
    // unix socket by redirecting the transport through a constructor option
    // (Deno's `client`). `webSocketOptions` is the escape hatch for that: here
    // we keep a plain `ws://` target and inject `ws`'s `createConnection` to
    // dial the socket — the same shape a Deno consumer would use for `client`.
    const socketPath = join(tmpdir(), `crossws-proxy-wsopts-${process.pid}.sock`);
    if (existsSync(socketPath)) unlinkSync(socketPath);

    const unixUpstream = nodeAdapter({
      hooks: defineHooks({
        message(peer, message) {
          peer.send(`echo:${message.text()}`);
        },
      }),
    });
    const unixUpstreamServer = createServer((_req, res) => res.end("ok"));
    unixUpstreamServer.on("upgrade", unixUpstream.handleUpgrade);
    await new Promise<void>((resolve) => unixUpstreamServer.listen(socketPath, resolve));

    const optsProxy = nodeAdapter({
      hooks: createWebSocketProxy({
        target: "ws://localhost/",
        WebSocket: WsWebSocket as unknown as typeof WebSocket,
        webSocketOptions: () => ({
          createConnection: () => netConnect({ path: socketPath }),
        }),
      }),
    });
    const server = createServer((_req, res) => res.end("ok"));
    server.on("upgrade", optsProxy.handleUpgrade);
    const port = await getRandomPort("localhost");
    await new Promise<void>((resolve) => server.listen(port, resolve));
    await waitForPort(port);
    try {
      const ws = await wsConnect(`ws://localhost:${port}/`);
      await ws.send("via-opts");
      expect(await ws.next()).toBe("echo:via-opts");
    } finally {
      server.closeAllConnections?.();
      server.close();
      unixUpstreamServer.closeAllConnections?.();
      unixUpstreamServer.close();
      if (existsSync(socketPath)) unlinkSync(socketPath);
    }
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

  test("merges webSocketOptions into the constructor's third argument", () => {
    const calls: Array<{ options: unknown }> = [];
    class StubWS extends EventTarget {
      binaryType = "arraybuffer";
      readyState = 0;
      constructor(_url: unknown, _protocols: unknown, options?: unknown) {
        super();
        calls.push({ options });
      }
      send(): void {}
      close(): void {}
    }
    const peer = {
      id: "p-opts",
      request: new Request("http://localhost/", { headers: { cookie: "sid=abc" } }),
      close() {},
      send() {},
    };

    // A per-peer resolver's keys land in the third argument, and the dedicated
    // `headers` option is applied on top of any `headers` key it returns.
    const marker = { transport: "unix" };
    const withResolver = createWebSocketProxy({
      target: "ws://upstream.invalid/",
      WebSocket: StubWS as unknown as typeof WebSocket,
      connectTimeout: 0,
      webSocketOptions: (p) => ({ client: marker, headers: { "x-ignored": p.id } }),
      headers: (p) => ({ cookie: p.request?.headers.get("cookie") ?? "" }),
    });
    withResolver.open?.(peer as never);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toEqual({
      client: marker,
      headers: { cookie: "sid=abc" },
    });

    // A static object works too, and passes through with no headers option.
    calls.length = 0;
    const withStatic = createWebSocketProxy({
      target: "ws://upstream.invalid/",
      WebSocket: StubWS as unknown as typeof WebSocket,
      connectTimeout: 0,
      webSocketOptions: { agent: false },
    });
    withStatic.open?.({ ...peer, id: "p-opts-static" } as never);
    expect(calls[0]!.options).toEqual({ agent: false });
  });

  test("omits the third argument when neither headers nor webSocketOptions is set", () => {
    const calls: Array<{ argc: number }> = [];
    class StubWS extends EventTarget {
      binaryType = "arraybuffer";
      readyState = 0;
      constructor(..._args: unknown[]) {
        super();
        calls.push({ argc: _args.length });
      }
      send(): void {}
      close(): void {}
    }
    const hooks = createWebSocketProxy({
      target: "ws://upstream.invalid/",
      WebSocket: StubWS as unknown as typeof WebSocket,
      connectTimeout: 0,
    });
    hooks.open?.({
      id: "p-noopts",
      request: new Request("http://localhost/"),
      close() {},
      send() {},
    } as never);
    // Only (url, protocols) — no third options object fabricated.
    expect(calls).toEqual([{ argc: 2 }]);
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

  test("_parseUnixTarget splits socket path from request path", () => {
    const parse = (s: string) => _parseUnixTarget(new URL(s));
    // Absolute socket path + request path.
    expect(parse("ws+unix:///run/app.sock:/chat")).toEqual({
      socketPath: "/run/app.sock",
      path: "/chat",
    });
    // Query string is carried onto the request path.
    expect(parse("ws+unix:///run/app.sock:/chat?room=1")).toEqual({
      socketPath: "/run/app.sock",
      path: "/chat?room=1",
    });
    // Missing request path defaults to "/".
    expect(parse("ws+unix:///run/app.sock:")).toEqual({
      socketPath: "/run/app.sock",
      path: "/",
    });
    // No colon at all — the whole path is the socket path.
    expect(parse("ws+unix:///run/app.sock")).toEqual({
      socketPath: "/run/app.sock",
      path: "/",
    });
  });

  test("_remapIncomingCode rewrites reserved pseudo-codes before peer close", () => {
    expect(_remapIncomingCode(undefined)).toBeUndefined();
    expect(_remapIncomingCode(1000)).toBe(1000);
    expect(_remapIncomingCode(1005)).toBe(1000);
    expect(_remapIncomingCode(1006)).toBe(1011);
    expect(_remapIncomingCode(1015)).toBe(1011);
    expect(_remapIncomingCode(4321)).toBe(4321);
  });

  test("_resolveProtocols resolves boolean and function forms", () => {
    const peerWith = (protocol?: string) =>
      ({
        request: new Request(
          "http://localhost/",
          protocol ? { headers: { "sec-websocket-protocol": protocol } } : undefined,
        ),
      }) as never;

    // boolean: undefined/true forwards the client header verbatim
    expect(_resolveProtocols(peerWith("a, b"), undefined)).toEqual(["a", "b"]);
    expect(_resolveProtocols(peerWith("a, b"), true)).toEqual(["a", "b"]);
    expect(_resolveProtocols(peerWith(), true)).toBeUndefined();

    // boolean false: offer nothing
    expect(_resolveProtocols(peerWith("a, b"), false)).toBeUndefined();

    // function: string, array, undefined
    expect(_resolveProtocols(peerWith("a"), () => "x")).toEqual(["x"]);
    expect(_resolveProtocols(peerWith("a"), () => ["x", " y "])).toEqual(["x", "y"]);
    expect(_resolveProtocols(peerWith("a"), () => undefined)).toBeUndefined();
    expect(_resolveProtocols(peerWith("a"), () => [])).toBeUndefined();
    expect(_resolveProtocols(peerWith("a"), () => ["", "  "])).toBeUndefined();

    // function: re-label client token for the upstream
    const stripPrefix = (peer: { request: Request }) =>
      (peer.request.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => (p.startsWith("x-test-") ? p.slice("x-test-".length) : p));
    expect(_resolveProtocols(peerWith("x-test-vite-hmr"), stripPrefix as never)).toEqual([
      "vite-hmr",
    ]);

    // static string / string[]: offer a fixed value regardless of the client
    expect(_resolveProtocols(peerWith("x-test-vite-hmr"), "vite-hmr")).toEqual(["vite-hmr"]);
    expect(_resolveProtocols(peerWith(), "vite-hmr")).toEqual(["vite-hmr"]);
    expect(_resolveProtocols(peerWith("a"), [" v1 ", "v2", ""])).toEqual(["v1", "v2"]);
    expect(_resolveProtocols(peerWith("a"), "  ")).toBeUndefined();

    // rewrite map: swap mapped tokens, pass the rest through verbatim
    expect(
      _resolveProtocols(peerWith("pspace-proxied-vite-hmr, chat"), {
        "pspace-proxied-vite-hmr": "vite-hmr",
      }),
    ).toEqual(["vite-hmr", "chat"]);
    // map with no matching client tokens forwards them unchanged
    expect(_resolveProtocols(peerWith("chat"), { other: "x" })).toEqual(["chat"]);
    // map ignores inherited keys (no client header → nothing to offer)
    expect(_resolveProtocols(peerWith(), { a: "b" })).toBeUndefined();
    expect(_resolveProtocols(peerWith("toString"), {})).toEqual(["toString"]);

    // de-dupe: a rewrite map collapsing several tokens onto one value, or a
    // client offering duplicates, must not produce repeats (the WHATWG
    // WebSocket constructor rejects a protocols list with duplicates).
    expect(_resolveProtocols(peerWith("proxied-hmr, hmr"), { "proxied-hmr": "hmr" })).toEqual([
      "hmr",
    ]);
    expect(_resolveProtocols(peerWith("a, a, b"), true)).toEqual(["a", "b"]);
    expect(_resolveProtocols(peerWith("a"), () => ["x", "x"])).toEqual(["x"]);

    // nullish entries inside a returned/mapped list are dropped, not coerced
    // to the literal strings "null"/"undefined".
    expect(_resolveProtocols(peerWith("a"), () => ["vite-hmr", null as never])).toEqual([
      "vite-hmr",
    ]);
    expect(_resolveProtocols(peerWith("a, b"), { a: undefined as never })).toEqual(["b"]);
  });

  test("forwardProtocol resolver feeds the upstream constructor's protocols argument", () => {
    const calls: Array<{ protocols: unknown }> = [];
    class StubWS extends EventTarget {
      binaryType = "arraybuffer";
      readyState = 0;
      constructor(_url: unknown, protocols?: unknown) {
        super();
        calls.push({ protocols });
      }
      send(): void {}
      close(): void {}
    }
    const hooks = createWebSocketProxy({
      target: "ws://upstream.invalid/",
      WebSocket: StubWS as unknown as typeof WebSocket,
      connectTimeout: 0,
      forwardProtocol: (peer) =>
        (peer.request?.headers.get("sec-websocket-protocol") ?? "")
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean)
          .map((p) => (p.startsWith("x-test-") ? p.slice("x-test-".length) : p)),
    });
    const peer = {
      id: "p-proto",
      request: new Request("http://localhost/", {
        headers: { "sec-websocket-protocol": "x-test-vite-hmr" },
      }),
      close() {},
      send() {},
    };
    hooks.open?.(peer as never);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.protocols).toEqual(["vite-hmr"]);

    // The client-facing echo stays the client-offered token, not the resolved one.
    expect(hooks.upgrade?.(peer.request)).toMatchObject({
      headers: { "sec-websocket-protocol": "x-test-vite-hmr" },
    });
  });
});
