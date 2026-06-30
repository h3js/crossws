// Bench baseline — Bun NATIVE (raw Bun.serve, NO crossws adapter).
// Run: bun ./server.bun-native.ts   (or `pnpm server:bun-native`)
//
// This is the control for the suite: it reproduces the exact same chat-room
// semantics as shared.ts (join one room, broadcast every message to everyone
// including the sender) but wired straight into Bun's native WebSocket API and
// with no dependency on crossws at all. Comparing it against `server.bun.ts`
// (same runtime, via the crossws bun adapter) isolates the adapter's overhead.
//
// Mirrors oven-sh/bun `bench/websocket-server/chat-server.bun.js`.

const port = Number.parseInt(process.env.PORT || "", 10) || 4001;

Bun.serve({
  port,
  websocket: {
    perMessageDeflate: false,
    publishToSelf: true, // sender also receives its own broadcast
    open(ws) {
      ws.subscribe("room");
      ws.send("ready"); // resolves the client's connect promise
    },
    message(ws, message) {
      ws.publish("room", message); // fan out to everyone (incl. sender)
    },
  },
  fetch(request, server) {
    if (request.headers.get("upgrade") === "websocket" && server.upgrade(request)) {
      return;
    }
    return new Response("websocket only", { status: 426 });
  },
});

console.log(`[bun-native] bench server listening on :${port}`);
