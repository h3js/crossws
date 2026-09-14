import { describe, test, expect, vi, afterEach } from "vitest";
import bunnyAdapter from "../../src/adapters/bunny.ts";

describe("bunny", () => {
  // Bunny.net edge scripting has no local runtime. Unit-test the adapter
  // against a minimal fake of `request.upgradeWebSocket` and the `Bunny`
  // global; end-to-end behaviour is verified manually on Bunny.net.

  afterEach(() => {
    delete (globalThis as any).Bunny;
  });

  test("adapter module exports", () => {
    expect(typeof bunnyAdapter).toBe("function");
  });

  test("keeps the isolate alive until the socket closes", async () => {
    const waitUntil = vi.fn();
    (globalThis as any).Bunny = { v1: { waitUntil } };

    const socket = new EventTarget() as EventTarget & { send: () => void; close: () => void };
    socket.send = vi.fn();
    socket.close = vi.fn();
    const response = new Response(null, { status: 200 });
    const request = Object.assign(new Request("https://example.com/_ws"), {
      upgradeWebSocket: () => ({ response, socket }),
    });

    const ws = bunnyAdapter({ hooks: {} });
    await expect(ws.handleUpgrade(request)).resolves.toBe(response);

    expect(waitUntil).toHaveBeenCalledTimes(1);
    const closed = waitUntil.mock.calls[0]![0] as Promise<void>;
    expect(closed).toBeInstanceOf(Promise);

    let settled = false;
    closed.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    socket.dispatchEvent(Object.assign(new Event("close"), { code: 1000, reason: "" }));
    await closed;
    expect(settled).toBe(true);
  });

  test("settles the keepalive promise on socket error", async () => {
    const waitUntil = vi.fn();
    (globalThis as any).Bunny = { v1: { waitUntil } };

    const socket = new EventTarget() as EventTarget & { send: () => void; close: () => void };
    socket.send = vi.fn();
    socket.close = vi.fn();
    const request = Object.assign(new Request("https://example.com/_ws"), {
      upgradeWebSocket: () => ({ response: new Response(null, { status: 200 }), socket }),
    });

    const ws = bunnyAdapter({ hooks: { error: () => {} } });
    await ws.handleUpgrade(request);

    socket.dispatchEvent(new Event("error"));
    await expect(waitUntil.mock.calls[0]![0]).resolves.toBeUndefined();
  });

  test("works without the Bunny global (local/dev)", async () => {
    const socket = new EventTarget() as EventTarget & { send: () => void; close: () => void };
    socket.send = vi.fn();
    socket.close = vi.fn();
    const request = Object.assign(new Request("https://example.com/_ws"), {
      upgradeWebSocket: () => ({ response: new Response(null, { status: 200 }), socket }),
    });
    const ws = bunnyAdapter({ hooks: {} });
    await expect(ws.handleUpgrade(request)).resolves.toBeInstanceOf(Response);
  });
});
