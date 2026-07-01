// Unix-socket proxy fixture for Deno. Spawned by test/proxy-runtimes.test.ts.
// Run manually with: deno run --unstable-byonm --unstable-net -A ./proxy-unix.deno.ts

import denoAdapter from "../../src/adapters/deno.ts";
import { createWebSocketProxy, defineHooks } from "../../src/index.ts";

const port = Number.parseInt(Deno.env.get("PORT") || "") || 3001;
const socketPath = `/tmp/crossws-proxy-unix-deno-${Deno.pid}.sock`;
try {
  Deno.removeSync(socketPath);
} catch {
  // no stale socket to clean up
}

// Upstream echo server bound to a unix socket.
const upstream = denoAdapter({
  hooks: defineHooks({
    message(peer, message) {
      peer.send(`echo:${message.text()}`);
    },
  }),
});
Deno.serve({ path: socketPath }, (request, info) =>
  request.headers.get("upgrade") === "websocket"
    ? // A unix listener's `remoteAddr` is a `UnixAddr`; the adapter only reads
      // `remoteAddr` for a TCP-shaped address, so narrow it for the type-check.
      upstream.handleUpgrade(
        request,
        info as unknown as Parameters<typeof upstream.handleUpgrade>[1],
      )
    : new Response("ok"),
);

// TCP proxy dialing the unix upstream out of the box (Deno `client` transport).
const proxy = denoAdapter({
  hooks: createWebSocketProxy({ target: `ws+unix://${socketPath}:/` }),
});
Deno.serve({ hostname: "localhost", port }, (request, info) =>
  request.headers.get("upgrade") === "websocket"
    ? proxy.handleUpgrade(request, info)
    : new Response("ok"),
);
