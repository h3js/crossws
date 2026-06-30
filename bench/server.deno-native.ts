// Bench baseline — Deno NATIVE (raw Deno.serve, NO crossws adapter).
// Run: deno run -A ./server.deno-native.ts   (or `pnpm server:deno-native`)
//
// The Deno control for the suite: same chat-room semantics as shared.ts (join
// one room, broadcast every message to everyone including the sender) but wired
// straight onto Deno's native WebSocket API with no dependency on crossws.
// Comparing it against the `deno` row (same runtime, via the crossws deno
// adapter) isolates the adapter's overhead.
//
// Mirrors oven-sh/bun `bench/websocket-server/chat-server.deno.mjs`.

const port = Number.parseInt(Deno.env.get("PORT") || "", 10) || 4001;

const clients = new Set<WebSocket>();

Deno.serve(
  {
    hostname: "127.0.0.1",
    port,
    onListen: () => console.log(`[deno-native] bench server listening on :${port}`),
  },
  (request) => {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("websocket only", { status: 426 });
    }
    const { socket, response } = Deno.upgradeWebSocket(request);
    socket.onopen = () => {
      clients.add(socket);
      socket.send("ready"); // resolves the client's connect promise
    };
    socket.onmessage = (event) => {
      for (const client of clients) {
        client.send(event.data); // fan out to everyone (incl. sender)
      }
    };
    socket.onclose = () => clients.delete(socket);
    return response;
  },
);
