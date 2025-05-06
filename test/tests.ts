import { expect, test } from "vitest";
import { wsConnect } from "./_utils";

export interface WSTestOpts {
  adapter: string;
  pubsub?: boolean;
  resHeaders?: boolean;
}

export function wsTests(getURL: () => string, opts: WSTestOpts): void {
  test("http works", async () => {
    const response = await fetch(getURL().replace("ws", "http"));
    expect(response.status).toBe(200);
  });

  test("connect to websocket", async () => {
    const ws = await wsConnect(getURL());
    expect(await ws.next()).toMatch(/Welcome to the server \w+/);
  });

  test("send ping", async () => {
    const ws = await wsConnect(getURL(), { skip: 1 });
    await ws.send("ping");
    expect(await ws.next()).toBe("pong");
  });

  test("send message", async () => {
    const ws1 = await wsConnect(getURL(), { skip: 1 });
    const ws2 = await wsConnect(getURL(), { skip: 1 });
    if (opts.pubsub !== false) {
      expect(await ws1.next()).toMatch(/\w+ joined!/);
    }
    await ws1.send("hello from 1");
    expect(await ws1.next()).toBe("hello from 1");
    if (opts.pubsub !== false) {
      expect(await ws2.next()).toBe("hello from 1");
    }
    await ws2.send("hello from 2");
    if (opts.pubsub !== false) {
      expect(await ws1.next()).toBe("hello from 2");
    }
    expect(await ws2.next()).toBe("hello from 2");
  });

  test("binary message", async () => {
    const ws = await wsConnect(getURL(), { skip: 1 });
    await ws.send(new TextEncoder().encode("binary"));
    expect((await ws.next()).buffer).toMatchObject(
      new TextEncoder().encode("binary message works!").buffer,
    );
  });

  test.skipIf(opts.resHeaders === false)(
    "upgrade response headers",
    async () => {
      const ws = await wsConnect(getURL());
      expect(ws.inspector.headers).toMatchObject({
        connection: expect.stringMatching(/^upgrade$/i),
        "sec-websocket-accept": expect.any(String),
        "set-cookie": "cross-ws=1; SameSite=None; Secure",
        "x-powered-by": "cross-ws",
      });
    },
  );

  test("peer.request (headers, url, remoteAddress)", async () => {
    const ws = await wsConnect(getURL() + "?foo=bar", {
      skip: 1,
      headers: { "x-test": "1" },
    });
    await ws.send("debug");
    const { request, remoteAddress, context } = await ws.next();

    // Headers
    if (opts.adapter === "sse") {
      expect(request.headers["connection"]).toBe("keep-alive");
    } else {
      expect(request.headers["connection"]).toMatch(/^upgrade$/i);
      expect(request.headers["x-test"]).toBe("1");
    }

    // URL
    expect(request.url).toMatch(/^http:\/\/localhost:\d+\/\?foo=bar$/);
    const url = new URL(request.url);
    expect(url.search).toBe("?foo=bar");

    // Remote address
    if (!/sse|cloudflare/.test(opts.adapter)) {
      expect(remoteAddress).toMatch(/:{2}1|(?:0{4}:){7}0{3}1|127\.0\.\0\.1/);
    }

    // Context
    if (opts.adapter !== "cloudflare-durable") {
      expect(context.test).toBe("1");
    }
  });

  test("peer.websocket", async () => {
    const ws = await wsConnect(getURL() + "?foo=bar", {
      skip: 1,
      headers: {
        "Sec-WebSocket-Protocol": "crossws",
      },
    });
    await ws.send("debug");
    const { websocket } = await ws.next();
    expect(websocket).toMatchObject({
      readyState: 1,
      protocol: /ss/.test(opts.adapter) ? "" : "crossws",
      extensions: /sse/.test(opts.adapter)
        ? ""
        : /^permessage-deflate; client_max_window_bits/,
      url: getURL() + "?foo=bar",
    });
  });

  test.skipIf(opts.adapter === "sse")("upgrade fail response", async () => {
    const ws = await wsConnect(getURL() + "?unauthorized");
    expect(ws.error).toBeDefined();
    expect(ws.inspector).toMatchObject({
      status: 401,
      statusText: "Unauthorized",
      headers: {
        "content-type": expect.stringMatching(/^text\/plain/),
        "x-error": "unauthorized",
      },
    });
  });

  test("get peers from adapter", async () => {
    await wsConnect(getURL());
    await wsConnect(getURL());
    const response = await fetch(getURL().replace("ws", "http") + "peers");
    const { peers } = (await response.json()) as any;
    expect(peers.length).toBe(2);
  });

  test("get peers from peer", async () => {
    const ws1 = await wsConnect(getURL(), { skip: 1 });
    const ws2 = await wsConnect(getURL(), { skip: 1 });
    if (opts.pubsub !== false) {
      ws1.skip(); // join message for ws2
    }
    await ws1.send("peers");
    await ws2.send("peers");
    const { peers: peers1 } = await ws1.next();
    const { peers: peers2 } = await ws2.next();
    expect(peers1.length).toBe(2);
    expect(peers1).toMatchObject(peers2);
  });

  test.skipIf(opts.adapter.startsWith("cloudflare"))(
    "publish to all peers from adapter",
    async () => {
      const ws1 = await wsConnect(getURL(), { skip: 1 });
      const ws2 = await wsConnect(getURL(), { skip: 1 });
      ws1.skip(); // join message for ws2
      await fetch(
        getURL().replace("ws", "http") + `publish?topic=chat&message=ping`,
      );
      expect(await ws1.next()).toBe("ping");
      expect(await ws2.next()).toBe("ping");
    },
  );
}
