import { createServer } from "node:http";
import { EventEmitter, once } from "node:events";
import { getRandomPort } from "get-port-please";
import { test, expect, vi } from "vitest";
import { plugin, serve } from "../src/server/node.ts";
import { toBufferLike } from "../src/utils.ts";

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

test("node server plugin adds the upgrade listener once when serve() is called repeatedly", () => {
  const nodeServer = new EventEmitter();
  const serveFn = vi.fn();
  const server = { node: { server: nodeServer }, serve: serveFn } as any;

  plugin({ upgrade: () => ({}) } as any)(server);
  server.serve();
  server.serve();
  server.serve();

  expect(nodeServer.listenerCount("upgrade")).toBe(1);
  expect(serveFn).toHaveBeenCalledTimes(3);
});
