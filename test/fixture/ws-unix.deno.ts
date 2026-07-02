// `crossws/websocket` (Deno wrapper) unix-socket fixture. Spawned by
// test/websocket-runtimes.test.ts. Prints `WRAPPER_OK` on success.
// Run manually with: deno run --unstable-byonm --unstable-net -A ./ws-unix.deno.ts

import DenoWebSocket from "../../src/websocket/deno.ts";

const sock = `/tmp/crossws-ws-unix-deno-${Deno.pid}.sock`;
try {
  Deno.removeSync(sock);
} catch {
  // no stale socket to clean up
}

// Echo server bound to a unix socket. Echoes the payload plus the custom
// upgrade header it received, so the fixture also asserts header forwarding.
Deno.serve({ path: sock }, (req) => {
  if (req.headers.get("upgrade") === "websocket") {
    const hdr = req.headers.get("x-custom") ?? "MISSING";
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onmessage = (e) => socket.send(`echo:${e.data}:${hdr}`);
    return response;
  }
  return new Response("ok");
});
await new Promise((r) => setTimeout(r, 150));

// Dial `ws+unix:` through the wrapper, forwarding a custom upgrade header via
// the third options argument (the shape crossws's proxy uses).
const ws = new (DenoWebSocket as unknown as {
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

try {
  Deno.removeSync(sock);
} catch {
  // best-effort cleanup
}
if (result === "echo:hello:HVAL") {
  console.log("WRAPPER_OK");
  Deno.exit(0);
}
console.error("WRAPPER_FAIL:", result);
Deno.exit(1);
