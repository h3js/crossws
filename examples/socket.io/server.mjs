// Socket.IO integration example.
//
// Socket.IO uses two transports: WebSocket (upgrade) and HTTP long-polling.
// We route each through crossws:
//   - WebSocket upgrades → `fromNodeUpgradeHandler` → `io.engine.handleUpgrade`
//   - `/socket.io/*` HTTP requests → `fetchNodeHandler` → socket.io's own
//     `request` listener (which handles the client bundle AND delegates
//     polling requests to `io.engine.handleRequest`)
//
// Run with: `pnpm start` (from this directory).

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Server as SocketIOServer } from "socket.io";
import { fromNodeUpgradeHandler } from "crossws/adapters/node";
import { serve } from "crossws/server/node";
import { fetchNodeHandler } from "srvx/node";

// Socket.IO initializes `io.engine` inside `attach()`. We attach to a
// throwaway `http.Server` that never `.listen()`s — its request/upgrade
// listeners are never invoked, but the dummy server now holds socket.io's
// own `request` listener, which we reuse below to serve both the client
// bundle and the polling transport.
const dummyServer = createServer();
const io = new SocketIOServer(dummyServer, {
  serveClient: true, // serves the client bundle at /socket.io/socket.io.js
});
const [socketIoRequestListener] = dummyServer.listeners("request");

io.on("connection", (socket) => {
  console.log("[io] connection", socket.id);
  socket.emit("welcome", { from: "server", to: socket.id });

  socket.on("message", (text) => {
    console.log("[io] message", socket.id, text);
    io.emit("message", { from: socket.id, text });
  });

  socket.on("disconnect", (reason) => {
    console.log("[io] disconnect", socket.id, reason);
  });
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexHtml = await readFile(join(__dirname, "public/index.html"));

const server = serve({
  port: 3000,
  hostname: "127.0.0.1",

  async fetch(req) {
    const url = new URL(req.url);

    // Polling transport and the /socket.io/socket.io.js client bundle.
    if (url.pathname.startsWith("/socket.io/")) {
      return fetchNodeHandler(socketIoRequestListener, req);
    }

    if (url.pathname === "/") {
      return new Response(indexHtml, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return new Response("not found", { status: 404 });
  },

  // WebSocket transport.
  websocket: fromNodeUpgradeHandler((req, socket, head) => {
    io.engine.handleUpgrade(req, socket, head);
  }),
});

await server.ready();
console.log("→ http://127.0.0.1:3000");
