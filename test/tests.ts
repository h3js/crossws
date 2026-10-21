import { expect, test } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
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

  test.skipIf(opts.resHeaders === false)("upgrade response headers", async () => {
    const ws = await wsConnect(getURL());
    expect(ws.inspector.headers).toMatchObject({
      connection: expect.stringMatching(/^upgrade$/i),
      "sec-websocket-accept": expect.any(String),
      "set-cookie": "cross-ws=1; SameSite=None; Secure",
      "x-powered-by": "cross-ws",
    });
  });

  test.skipIf(opts.adapter === "sse")("negotiate sub-protocol", async () => {
    const ws = await wsConnect(getURL(), {
      headers: { "sec-websocket-protocol": "supported" },
    });
    expect(ws.inspector.headers).toMatchObject({
      "sec-websocket-protocol": "supported",
    });
  });

  test.skipIf(opts.adapter === "sse")("reject sub-protocol", async () => {
    const ws = await wsConnect(getURL(), {
      headers: { "sec-websocket-protocol": "unsupported" },
    });
    if (opts.adapter === "bun") {
      // This is a bug in Bun!
      // https://github.com/oven-sh/bun/issues/18243
      expect(ws.inspector.headers).toMatchObject({
        "sec-websocket-protocol": "unsupported",
      });
    } else {
      expect(ws.inspector.headers).not.toMatchObject({
        "sec-websocket-protocol": "unsupported",
      });
    }
  });

  // Negotiate via the per-connection `protocol` field returned from `upgrade()`.
  test.runIf(/^(node|bun|deno)$/.test(opts.adapter))(
    "negotiate sub-protocol via upgrade() protocol field",
    async () => {
      const ws = await wsConnect(getURL(), {
        headers: { "sec-websocket-protocol": "graphql-transport-ws" },
      });
      expect(ws.inspector.headers).toMatchObject({
        "sec-websocket-protocol": "graphql-transport-ws",
      });
    },
  );

  // Negotiate via the global `handleProtocols` adapter option.
  test.runIf(/^(node|bun|deno)$/.test(opts.adapter))(
    "negotiate sub-protocol via handleProtocols option",
    async () => {
      const ws = await wsConnect(getURL(), {
        headers: { "sec-websocket-protocol": "chat" },
      });
      expect(ws.inspector.headers).toMatchObject({
        "sec-websocket-protocol": "chat",
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
      // eslint-disable-next-line no-control-regex
      expect(remoteAddress).toMatch(/:{2}1|(?:0{4}:){7}0{3}1|127\.0\.\0\.1/);
    }

    // Context
    if (opts.adapter !== "cloudflare-durable") {
      expect(context.test).toBe("1");
    }
  });

  test.runIf(/^(bun|deno)$/.test(opts.adapter))(
    "close hook receives the client's code and reason",
    async () => {
      const ws = await wsConnect(getURL(), { skip: 1 });
      await ws.send("debug");
      const { id } = await ws.next();
      ws.ws.close(4000, "bye");
      await expect
        .poll(() =>
          fetch(getURL().replace("ws", "http") + `close-details?peer=${id}`).then((r) => r.json()),
        )
        .toEqual({ code: 4000, reason: "bye" });
    },
  );

  test("peer.bufferedAmount", async () => {
    const ws = await wsConnect(getURL(), { skip: 1 });
    await ws.send("debug");
    const { bufferedAmount } = await ws.next();
    // Adapters without a buffer signal report 0; capable ones report >= 0.
    expect(typeof bufferedAmount).toBe("number");
    expect(bufferedAmount).toBeGreaterThanOrEqual(0);
  });

  test("peer.waitForDrain", async () => {
    const ws = await wsConnect(getURL(), { skip: 1 });
    await ws.send("waitForDrain");
    expect(await ws.next()).toBe("drained");
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
      extensions: /sse/.test(opts.adapter) ? "" : /^permessage-deflate; client_max_window_bits/,
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
        "www-authenticate": 'Bearer realm="crossws"',
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

  test.skipIf(opts.adapter === "cloudflare" /* durable only */)(
    "publish to all peers from adapter",
    async () => {
      const ws1 = await wsConnect(getURL(), { skip: 1 });
      const ws2 = await wsConnect(getURL(), { skip: 1 });
      ws1.skip(); // join message for ws2
      await fetch(getURL().replace("ws", "http") + `publish?topic=chat&message=ping`);
      expect(await ws1.next()).toBe("ping");
      expect(await ws2.next()).toBe("ping");
    },
  );
}

/**
 * Application-level ping/pong control frames aren't reachable through the
 * standard `WebSocket` API (browsers/undici auto-answer them invisibly to
 * JS), so — unlike {@link wsTests} — this suite connects with the `ws`
 * package, which exposes `.ping()`/`.pong()` and the raw `ping`/`pong`
 * events. Only wired up for adapters that support it (node, uws, bun); refer
 * to the [compatibility table](https://crossws.h3.dev/guide/peer#compatibility).
 */
export function pingPongTests(getURL: () => string): void {
  // Queues inbound text messages (attached before `open` resolves, so the
  // fixture's immediate "Welcome ..." message can't be missed in the race
  // between connecting and a test attaching its own listener) so a test can
  // skip past it and assert on the next message deterministically.
  const connect = () => {
    const client = new NodeWebSocket(getURL());
    const queue: string[] = [];
    let pending: ((message: string) => void) | undefined;
    client.on("message", (data) => {
      const text = data.toString();
      if (pending) {
        pending(text);
        pending = undefined;
      } else {
        queue.push(text);
      }
    });
    // The tests only ever await `next()` sequentially, so a plain FIFO queue
    // with a single pending resolver is enough.
    const next = (): Promise<string> => {
      if (queue.length > 0) {
        return Promise.resolve(queue.shift()!);
      }
      return new Promise((resolve) => {
        pending = resolve;
      });
    };
    return new Promise<{ client: NodeWebSocket; next: () => Promise<string> }>(
      (resolve, reject) => {
        client.once("open", () => resolve({ client, next }));
        client.once("error", reject);
      },
    );
  };

  test("ping hook observes an inbound ping from the client", async () => {
    const { client, next } = await connect();
    await next(); // "Welcome ..." from the `open` hook
    client.ping("client-ping");
    expect(await next()).toBe("ping-received:client-ping");
    client.close();
  });

  test("pong hook observes an inbound pong from the client", async () => {
    const { client, next } = await connect();
    await next(); // "Welcome ..." from the `open` hook
    client.pong("client-pong");
    expect(await next()).toBe("pong-received:client-pong");
    client.close();
  });

  test("peer.ping() sends a ping frame the client receives", async () => {
    const { client } = await connect();
    const pingReceived = new Promise<string>((resolve) => {
      client.once("ping", (data) => resolve(data.toString()));
    });
    client.send("ping-me");
    expect(await pingReceived).toBe("server-ping");
    client.close();
  });
}
