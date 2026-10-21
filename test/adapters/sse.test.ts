import { describe, beforeAll, vi, afterAll, test, expect } from "vitest";
import { wsTestsExec } from "../_utils";
import { WebSocketSSE } from "../../src/websocket/sse";
import sseAdapter from "../../src/adapters/sse";
import * as undici from "undici";

globalThis.EventSource = globalThis.EventSource || (undici.EventSource as any);

describe("sse", () => {
  beforeAll(() => {
    vi.stubGlobal("WebSocket", WebSocketSSE);
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });
  wsTestsExec("deno run --unstable-byonm -A ./sse.ts", {
    adapter: "sse",
    resHeaders: false, // works but not testable
  });
});

describe("sse (close hook)", () => {
  test("passes a details object when the client disconnects", async () => {
    const close = vi.fn();
    const ws = sseAdapter({ hooks: { close } });
    const response = await ws.fetch(new Request("http://localhost/"));
    await response.body!.cancel();
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith(expect.anything(), {}));
  });
});
