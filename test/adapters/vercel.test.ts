import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { getRandomPort, waitForPort } from "get-port-please";
import type { ServerRequest } from "srvx";
import vercelAdapter from "../../src/adapters/vercel";
import { createDemo } from "../fixture/_shared";
import { wsTests } from "../tests";
import { wsConnect } from "../_utils";

const VERCEL_REQUEST_CONTEXT_SYMBOL = Symbol.for("@vercel/request-context");

interface UpgradeTuple {
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
}

describe("vercel", () => {
  let server: Server;
  let url: string;
  const ws = createDemo(vercelAdapter);

  test("does not handle non-upgrade fetch requests", async () => {
    await expect(ws.handleUpgrade(new Request("https://example.com/"))).resolves.toBeUndefined();
  });

  test("does not handle websocket requests without Vercel request context", async () => {
    const previous = getGlobalRequestContext();
    deleteGlobalRequestContext();
    try {
      await expect(
        ws.handleUpgrade(
          new Request("https://example.com/", {
            headers: { upgrade: "websocket" },
          }),
        ),
      ).resolves.toBeUndefined();
    } finally {
      restoreGlobalRequestContext(previous);
    }
  });

  test("does not handle non-upgrade node requests", async () => {
    await expect(
      ws.handleUpgrade(
        { method: "GET", headers: {} } as IncomingMessage,
        {
          headersSent: false,
          writableEnded: false,
          end: () => {},
        } as never,
      ),
    ).resolves.toBe(false);
  });

  describe("fetch-style handleUpgrade", () => {
    beforeAll(async () => {
      server = createServer((req, res) => {
        if (req.url === "/peers") {
          return res.end(
            JSON.stringify({
              peers: [...ws.peers].flatMap(([namespace, peers]) =>
                [...peers].map((p) => `${namespace}:${p.id}`),
              ),
            }),
          );
        }
        if (req.url!.startsWith("/publish")) {
          const q = new URLSearchParams(req.url!.split("?")[1]);
          const topic = q.get("topic") || "";
          const message = q.get("message") || "";
          if (topic && message) {
            ws.publish(topic, message);
            return res.end("published");
          }
        }
        res.end("ok");
      });
      server.on("upgrade", async (req, socket, head) => {
        const previous = installVercelUpgrade({ req, socket, head });
        try {
          await ws.handleUpgrade(toVercelWebRequest(req));
        } catch (error) {
          socket.destroy(error as Error);
        } finally {
          restoreGlobalRequestContext(previous);
        }
      });
      const port = await getRandomPort("localhost");
      url = `ws://localhost:${port}/`;
      await new Promise<void>((resolve) => server.listen(port, resolve));
      await waitForPort(port);
    });

    afterAll(() => {
      ws.closeAll();
      server.close();
    });

    wsTests(() => url, {
      adapter: "vercel",
    });
  });

  test("passes node upgrade runtime metadata to resolved hooks", async () => {
    let seenNodeRuntime:
      | {
          req?: IncomingMessage;
          upgrade?: {
            socket?: Duplex;
            head?: Buffer;
          };
        }
      | undefined;
    const runtimeWs = vercelAdapter({
      hooks: {
        upgrade(request) {
          seenNodeRuntime = (
            request as ServerRequest & {
              runtime?: {
                node?: typeof seenNodeRuntime;
              };
            }
          ).runtime?.node;
          return new Response("handled", { status: 418 });
        },
      },
    });
    const runtimeServer = createServer();

    runtimeServer.on("upgrade", async (req, socket, head) => {
      const previous = installVercelUpgrade({ req, socket, head });
      try {
        await runtimeWs.handleUpgrade(toVercelWebRequest(req));
      } catch (error) {
        socket.destroy(error as Error);
      } finally {
        restoreGlobalRequestContext(previous);
      }
    });

    try {
      const port = await listen(runtimeServer);
      const client = await wsConnect(`ws://localhost:${port}/runtime`);

      expect(client.error).toBeDefined();
      expect(client.inspector.status).toBe(418);
      expect(seenNodeRuntime).toMatchObject({
        req: expect.any(Object),
        upgrade: {
          socket: expect.any(Object),
          head: expect.any(Buffer),
        },
      });
    } finally {
      await closeServer(runtimeServer);
      runtimeWs.closeAll();
    }
  });
});

function installVercelUpgrade(upgrade: UpgradeTuple): unknown {
  const previous = getGlobalRequestContext();
  (globalThis as Record<symbol, unknown>)[VERCEL_REQUEST_CONTEXT_SYMBOL] = {
    get: () => ({
      upgradeWebSocket: () => upgrade,
    }),
  };
  return previous;
}

function getGlobalRequestContext(): unknown {
  return (globalThis as Record<symbol, unknown>)[VERCEL_REQUEST_CONTEXT_SYMBOL];
}

function deleteGlobalRequestContext(): void {
  delete (globalThis as Record<symbol, unknown>)[VERCEL_REQUEST_CONTEXT_SYMBOL];
}

function restoreGlobalRequestContext(previous: unknown): void {
  if (previous === undefined) {
    deleteGlobalRequestContext();
  } else {
    (globalThis as Record<symbol, unknown>)[VERCEL_REQUEST_CONTEXT_SYMBOL] = previous;
  }
}

function toVercelWebRequest(req: IncomingMessage): Request {
  const host = req.headers.host || "localhost";
  const protocol = (req.socket as { encrypted?: boolean }).encrypted ? "https" : "http";
  return new Request(`${protocol}://${host}${req.url || "/"}`, {
    method: req.method,
    headers: toWebHeaders(req),
  });
}

function toWebHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }
  return headers;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "localhost", resolve);
  });
  return (server.address() as { port: number }).port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
