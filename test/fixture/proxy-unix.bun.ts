// Unix-socket proxy fixture for Bun. Spawned by test/proxy-runtimes.test.ts.
// Run manually with: bun run ./proxy-unix.bun.ts

import { unlinkSync } from "node:fs";
import bunAdapter from "../../src/adapters/bun.ts";
import { createWebSocketProxy, defineHooks } from "../../src/index.ts";

const port = Number.parseInt(process.env.PORT || "") || 3001;
const socketPath = `/tmp/crossws-proxy-unix-bun-${process.pid}.sock`;
try {
  unlinkSync(socketPath);
} catch {
  // no stale socket to clean up
}

// Upstream echo server bound to a unix socket.
const upstream = bunAdapter({
  hooks: defineHooks({
    message(peer, message) {
      peer.send(`echo:${message.text()}`);
    },
  }),
});
Bun.serve({
  unix: socketPath,
  websocket: upstream.websocket,
  fetch: (request, server) =>
    request.headers.get("upgrade") === "websocket"
      ? upstream.handleUpgrade(request, server)
      : new Response("ok"),
});

// TCP proxy dialing the unix upstream out of the box (Bun's native `ws+unix:`).
const proxy = bunAdapter({
  hooks: createWebSocketProxy({ target: `ws+unix://${socketPath}:/` }),
});
Bun.serve({
  port,
  hostname: "localhost",
  websocket: proxy.websocket,
  fetch: (request, server) =>
    request.headers.get("upgrade") === "websocket"
      ? proxy.handleUpgrade(request, server)
      : new Response("ok"),
});
