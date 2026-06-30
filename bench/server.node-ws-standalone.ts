// Bench baseline — Node.js + `ws` STANDALONE (raw `ws`, NO crossws adapter).
// Run: node ./server.node-ws-standalone.ts   (or `pnpm server:node-ws-standalone`)
//
// The Node control for the suite: same chat-room semantics as shared.ts (join
// one room, broadcast every message to everyone including the sender) but wired
// straight onto the `ws` package with no dependency on crossws. Comparing it
// against the `node-ws` row (same runtime, via the crossws node adapter)
// isolates the adapter's overhead.
//
// Mirrors oven-sh/bun `bench/websocket-server/chat-server.node.mjs`.

import { WebSocketServer } from "ws";

const port = Number.parseInt(process.env.PORT || "", 10) || 4001;

const wss = new WebSocketServer({ host: "127.0.0.1", port });
const clients = new Set<import("ws").WebSocket>();

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send("ready"); // resolves the client's connect promise

  ws.on("message", (data) => {
    const msg = typeof data === "string" ? data : data.toString();
    for (const client of clients) {
      client.send(msg); // fan out to everyone (incl. sender)
    }
  });

  ws.on("close", () => clients.delete(ws));
});

wss.on("listening", () => {
  console.log(`[node-ws-standalone] bench server listening on :${port}`);
});
