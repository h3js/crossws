// `crossws/websocket` (Bun wrapper) unix-socket fixture. Spawned by
// test/websocket-runtimes.test.ts. Prints `WRAPPER_OK` on success.
// Run manually with: bun run ./ws-unix.bun.ts

import { unlinkSync } from "node:fs";
import BunWebSocket from "../../src/websocket/bun.ts";

const sock = `/tmp/crossws-ws-unix-bun-${process.pid}.sock`;
try {
  unlinkSync(sock);
} catch {
  // no stale socket to clean up
}

// Echo server bound to a unix socket. Echoes the payload plus the custom
// upgrade header it received, so the fixture also asserts header forwarding.
// The header is stashed in a closure (single connection) to avoid depending on
// Bun's `ServerWebSocket.data` typing, which isn't loaded under the repo tsconfig.
let seenHeader = "MISSING";
const server = Bun.serve({
  unix: sock,
  websocket: {
    message(ws, msg) {
      ws.send(`echo:${msg}:${seenHeader}`);
    },
  },
  fetch(req, srv) {
    seenHeader = req.headers.get("x-custom") ?? "MISSING";
    return srv.upgrade(req) ? undefined : new Response("ok");
  },
});
await new Promise((r) => setTimeout(r, 150));

// Dial `ws+unix:` through the wrapper (Bun handles the scheme natively), while
// forwarding a custom upgrade header via the third options argument — Bun only
// reads options from its second argument, so the wrapper must relay it there.
const ws = new (BunWebSocket as unknown as {
  new (url: string, protocols?: string | string[], options?: Record<string, unknown>): WebSocket;
})(`ws+unix://${sock}:/chat`, undefined, { headers: { "x-custom": "HVAL" } });
const result = await new Promise<string>((resolve) => {
  const to = setTimeout(() => resolve("TIMEOUT"), 3000);
  ws.onopen = () => ws.send("hello");
  ws.onmessage = (e) => {
    clearTimeout(to);
    resolve(String(e.data));
  };
  ws.onerror = () => {
    clearTimeout(to);
    resolve("ERROR");
  };
});

server.stop(true);
try {
  unlinkSync(sock);
} catch {
  // best-effort cleanup
}
if (result === "echo:hello:HVAL") {
  console.log("WRAPPER_OK");
  process.exit(0);
}
console.error("WRAPPER_FAIL:", result);
process.exit(1);
