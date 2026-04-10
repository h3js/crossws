import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createServer, Server } from "node:http";
import { getRandomPort, waitForPort } from "get-port-please";
import nodeAdapter from "../src/adapters/node.ts";
import { createWebSocketProxy, defineHooks } from "../src/index.ts";
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
            const kind =
              typeof message.rawData === "string" ? "text" : "binary";
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
    await new Promise<void>((resolve) =>
      upstreamServer.listen(upstreamPort, resolve),
    );
    await waitForPort(upstreamPort);

    // Proxy server using createWebSocketProxy hooks
    const proxy = nodeAdapter({
      hooks: createWebSocketProxy(upstreamURL),
    });
    proxyServer = createServer((_req, res) => res.end("ok"));
    proxyServer.on("upgrade", proxy.handleUpgrade);
    const proxyPort = await getRandomPort("localhost");
    proxyURL = `ws://localhost:${proxyPort}/`;
    await new Promise<void>((resolve) =>
      proxyServer.listen(proxyPort, resolve),
    );
    await waitForPort(proxyPort);

    // Proxy server using dynamic target function
    const dynamicProxy = nodeAdapter({
      hooks: createWebSocketProxy({ target: () => upstreamURL }),
    });
    dynamicProxyServer = createServer((_req, res) => res.end("ok"));
    dynamicProxyServer.on("upgrade", dynamicProxy.handleUpgrade);
    const dynamicProxyPort = await getRandomPort("localhost");
    dynamicProxyURL = `ws://localhost:${dynamicProxyPort}/`;
    await new Promise<void>((resolve) =>
      dynamicProxyServer.listen(dynamicProxyPort, resolve),
    );
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
    await new Promise<void>((resolve) =>
      limitedProxyServer.listen(limitedProxyPort, resolve),
    );
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
    await new Promise<void>((resolve) =>
      badProxyServer.listen(badProxyPort, resolve),
    );
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
    await new Promise<void>((resolve) =>
      timeoutProxyServer.listen(timeoutProxyPort, resolve),
    );
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
    // proxy's buffer before the upstream connection opens.
    await ws.send("aaaaa"); // 5 bytes — fills the limit exactly
    await ws.send("bbbbb"); // 5 more bytes — exceeds
    const event = await closed;
    expect(event.code).toBe(1009);
  });
});
