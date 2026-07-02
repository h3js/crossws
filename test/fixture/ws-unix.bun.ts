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

// Echo server bound to a unix socket.
const server = Bun.serve({
  unix: sock,
  websocket: {
    message(ws, msg) {
      ws.send(`echo:${msg}`);
    },
  },
  fetch(req, srv) {
    return srv.upgrade(req) ? undefined : new Response("ok");
  },
});
await new Promise((r) => setTimeout(r, 150));

// Dial `ws+unix:` through the wrapper (Bun's global handles it natively).
const ws = new BunWebSocket(`ws+unix://${sock}:/chat`);
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
if (result === "echo:hello") {
  console.log("WRAPPER_OK");
  process.exit(0);
}
console.error("WRAPPER_FAIL:", result);
process.exit(1);
