import { describe, expect, test } from "vitest";
import { execa } from "execa";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import NodeWebSocket from "../src/websocket/node.ts";

// Coverage for the runtime-specific `crossws/websocket` wrappers. Each fixture
// spawns a real Deno/Bun process that dials a `ws+unix:` upstream through the
// wrapper's constructor and prints `WRAPPER_OK` on a successful echo round-trip.
const fixtureDir = fileURLToPath(new URL("fixture", import.meta.url));

function wrapperSuite(runtime: string, cmd: string) {
  describe(`crossws/websocket ws+unix (${runtime})`, () => {
    test("dials a unix-socket upstream via the runtime wrapper", async () => {
      const [bin, ...args] = cmd.replace("./", `${fixtureDir}/`).split(" ");
      const result = await execa(bin!, args, { reject: false });
      if (process.env.TEST_DEBUG) {
        console.log(result.stdout, result.stderr);
      }
      expect(result.stdout).toContain("WRAPPER_OK");
      expect(result.exitCode).toBe(0);
    }, 20_000);
  });
}

wrapperSuite("deno", "deno run --unstable-byonm --unstable-net -A ./ws-unix.deno.ts");
wrapperSuite("bun", "bun run ./ws-unix.bun.ts");

// Node runs the test process itself, so its wrapper is exercised in-process.
// Node's native `WebSocket` (undici) reads dialing options only from its second
// argument, so custom upgrade `headers` passed as the third argument — the shape
// crossws's proxy uses — must be routed through `ws` by the wrapper.
describe("crossws/websocket headers (node)", () => {
  test("forwards a custom upgrade header via the third options argument", async () => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on("connection", (ws, req) => {
      ws.send(
        `${req.headers["x-custom"] ?? "MISSING"}|${req.headers["sec-websocket-protocol"] ?? "NOPROTO"}`,
      );
    });
    await new Promise((r) => wss.on("listening", r));
    const { port } = wss.address() as AddressInfo;

    try {
      const result = await new Promise<string>((resolve) => {
        const ws = new (NodeWebSocket as unknown as {
          new (
            url: string,
            protocols?: string | string[],
            options?: Record<string, unknown>,
          ): WebSocket;
        })(`ws://localhost:${port}/`, ["chat"], { headers: { "x-custom": "HVAL" } });
        const to = setTimeout(() => resolve("TIMEOUT"), 3000);
        ws.onmessage = (e) => {
          clearTimeout(to);
          resolve(String(e.data));
          ws.close();
        };
        ws.onerror = () => {
          clearTimeout(to);
          resolve("ERROR");
        };
      });
      expect(result).toBe("HVAL|chat");
    } finally {
      wss.close();
    }
  }, 10_000);
});
