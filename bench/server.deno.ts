// crossws bench server — Deno (Deno.serve + crossws deno adapter)
// Run: deno run -A ./server.deno.ts   (or `pnpm server:deno`)

import denoAdapter from "../src/adapters/deno.ts";
import { createBench, getPort } from "./shared.ts";

const ws = createBench(denoAdapter);
const port = getPort();

(globalThis as any).Deno.serve(
  { port, onListen: () => console.log(`[deno] crossws bench server listening on :${port}`) },
  (request: Request, info: any) => {
    if (request.headers.get("upgrade") === "websocket") {
      return ws.handleUpgrade(request, info);
    }
    return new Response("websocket only", { status: 426 });
  },
);
