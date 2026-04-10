import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createServer, Server } from "node:http";
import { getRandomPort, waitForPort } from "get-port-please";
import nodeAdapter from "../src/adapters/node.ts";
import { defineHooks } from "../src/index.ts";
import { createWebSocketProxy } from "../src/proxy.ts";
import { wsConnect } from "./_utils.ts";

describe("createWebSocketProxy", () => {
  let upstreamServer: Server;
  let proxyServer: Server;
  let dynamicProxyServer: Server;
  let upstreamURL: string;
  let proxyURL: string;
  let dynamicProxyURL: string;

  beforeAll(async () => {
    // Upstream echo server (crossws node adapter)
    const upstream = nodeAdapter({
      hooks: defineHooks({
        open(peer) {
          peer.send("welcome");
        },
        message(peer, message) {
          const text = message.text();
          if (text === "getbinary") {
            peer.send(new TextEncoder().encode("binary-pong"));
          } else {
            peer.send(`echo:${text}`);
          }
        },
        upgrade(req) {
          if (req.headers.get("sec-websocket-protocol") === "chat") {
            return { headers: { "sec-websocket-protocol": "chat" } };
          }
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
  });

  afterAll(() => {
    for (const server of [proxyServer, dynamicProxyServer, upstreamServer]) {
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
});
