// crossws bench server — Bun (Bun.serve + crossws bun adapter)
// Run: bun ./server.bun.ts   (or `pnpm server:bun`)

import bunAdapter from "../src/adapters/bun.ts";
import { createBench, getPort } from "./shared.ts";

const ws = createBench(bunAdapter);
const port = getPort();

Bun.serve({
  port,
  websocket: ws.websocket,
  fetch(request, server) {
    if (request.headers.get("upgrade") === "websocket") {
      return ws.handleUpgrade(request, server);
    }
    return new Response("websocket only", { status: 426 });
  },
});

console.log(`[bun] crossws bench server listening on :${port}`);
