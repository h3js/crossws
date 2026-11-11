import { createServer } from "node:http";
import { once } from "node:events";
import { getRandomPort } from "get-port-please";
import { test, expect, vi } from "vitest";
import WebSocket from "ws";
import { serve } from "../src/server/node.ts";
import { toBufferLike } from "../src/utils.ts";
import type { ServerRequest } from "srvx";

test("toBufferLike", () => {
  expect(toBufferLike(undefined)).toBe("");
  expect(toBufferLike(null)).toBe("");
  expect(toBufferLike("")).toBe("");
  expect(toBufferLike("hello")).toBe("hello");
  expect(toBufferLike(123)).toBe("123");
  expect(toBufferLike({ a: 1 })).toBe('{"a":1}');
  expect(toBufferLike(Buffer.from("hello"))).toEqual(Buffer.from("hello"));
  expect(toBufferLike(new Uint8Array([1, 2, 3]))).toEqual(new Uint8Array([1, 2, 3]));
  expect(toBufferLike(new ArrayBuffer(3))).toEqual(new ArrayBuffer(3));
});

test("ready() rejects on EADDRINUSE", async () => {
  const port = await getRandomPort("localhost");
  const blocker = createServer().listen(port, "127.0.0.1");
  await once(blocker, "listening");
  const server = serve({
    port,
    hostname: "127.0.0.1",
    fetch: () => new Response("ok"),
    websocket: {},
  });
  await expect(server.ready()).rejects.toMatchObject({ code: "EADDRINUSE" });
  blocker.close();
});

async function serveWS(websocket: Parameters<typeof serve>[0]["websocket"], trustProxy?: boolean) {
  const port = await getRandomPort("localhost");
  const server = serve({
    port,
    hostname: "127.0.0.1",
    fetch: () => new Response("ok"),
    trustProxy,
    websocket,
  });
  await server.ready();
  return { server, url: `ws://127.0.0.1:${port}/` };
}

test("close(true) terminates connected WebSocket peers", async () => {
  const closed = vi.fn();
  const { server, url } = await serveWS({ close: closed });
  const client = new WebSocket(url);
  await once(client, "open");
  const clientClose = once(client, "close");

  await server.close(true);

  const [code] = await clientClose;
  expect(code).toBe(1006);
  await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
});

test("close() leaves connected WebSocket peers open", async () => {
  const { server, url } = await serveWS({
    message(peer, message) {
      peer.send(message.text());
    },
  });
  const client = new WebSocket(url);
  await once(client, "open");

  let closed = false;
  const closing = server.close().then(() => (closed = true));
  await new Promise((r) => setTimeout(r, 100));
  expect(closed).toBe(false);
  expect(client.readyState).toBe(WebSocket.OPEN);
  client.send("still here");
  const [reply] = await once(client, "message");
  expect(reply.toString()).toBe("still here");

  client.close();
  await closing;
});

test("failed rejection response write destroys the socket without an unhandled rejection", async () => {
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const { server, url } = await serveWS({
      // A body stream that errors makes writing the rejection response fail.
      upgrade: () =>
        new Response(
          new ReadableStream({
            pull: (controller) => controller.error(new Error("body failed")),
          }),
          { status: 403 },
        ),
    });
    const client = new WebSocket(url);
    client.on("error", () => {});
    await new Promise((r) => client.once("close", r));
    await new Promise((r) => setTimeout(r, 50));
    expect(unhandled).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      "[crossws] WebSocket upgrade failed:",
      expect.objectContaining({ message: "body failed" }),
    );
    await server.close(true);
  } finally {
    process.off("unhandledRejection", unhandled);
    consoleError.mockRestore();
  }
});

test("upgrade request uses the server's trustProxy and waitUntil", async () => {
  let request: ServerRequest | undefined;
  const { server, url } = await serveWS(
    {
      upgrade(req) {
        request = req as ServerRequest;
        return new Response(null, { status: 403 });
      },
    },
    true,
  );
  const client = new WebSocket(url, { headers: { "x-forwarded-for": "203.0.113.7" } });
  client.on("error", () => {});
  await new Promise((r) => client.once("close", r));
  expect(request?.ip).toBe("203.0.113.7");
  expect(request?.waitUntil).toBe(server.waitUntil);
  await server.close(true);
});
