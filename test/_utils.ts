import { Agent, WebSocket as WebSocketUndici } from "undici";
import { afterAll, beforeAll, afterEach } from "vitest";
import { execa, type ResultPromise as ExecaRes } from "execa";
import { fileURLToPath } from "node:url";
import { getRandomPort, waitForPort } from "get-port-please";
import { wsTests } from "./tests";
import type { Peer } from "../src";

const fixtureDir = fileURLToPath(new URL("fixture", import.meta.url));

const nativeWebSocket = globalThis.WebSocket;

const websockets = new Set<WebSocket>();
afterEach(() => {
  for (const ws of websockets) {
    ws.close();
  }
  websockets.clear();
});

export function wsConnect(
  url: string,
  opts?: { skip?: number; headers?: HeadersInit },
) {
  const inspector = new WebSocketInspector();
  // Prefer undici's WebSocket so the inspector dispatcher intercepts the
  // upgrade; the native global ignores `dispatcher`. Respect stubs set by
  // tests (e.g. SSE replaces globalThis.WebSocket).
  const _WebSocket: any =
    globalThis.WebSocket === nativeWebSocket
      ? WebSocketUndici
      : globalThis.WebSocket || WebSocketUndici;
  const ws = new _WebSocket(url, {
    headers: opts?.headers,
    dispatcher: inspector,
  }) as WebSocket;
  ws.binaryType = "arraybuffer";

  websockets.add(ws);

  const send = async (data: any): Promise<any> => {
    ws.send(
      typeof data === "string" ? data : JSON.stringify({ message: data }),
    );
  };

  const messages: unknown[] = [];

  const waitCallbacks: Record<string, (message: any) => void> = {};
  let nextIndex = opts?.skip || 0;
  const next = (): Promise<any> => {
    const index = nextIndex++;
    if (index < messages.length) {
      return Promise.resolve(messages[index]);
    }
    return new Promise<any>((resolve) => {
      waitCallbacks[index] = resolve;
    });
  };
  const skip = (count: number = 1): void => {
    nextIndex += count;
  };

  ws.addEventListener("message", async (event) => {
    let text: string;
    if (typeof event.data === "string") {
      text = event.data;
    } else {
      let rawData = event.data;
      if (rawData instanceof Blob) {
        rawData = await event.data.arrayBuffer();
      } else if (rawData instanceof Uint8Array) {
        rawData = rawData.buffer;
      }
      text = new TextDecoder().decode(rawData);
    }
    const payload = text[0] === "{" ? JSON.parse(text) : text;
    messages.push(payload);

    const index = messages.length - 1;
    if (waitCallbacks[index]) {
      waitCallbacks[index](payload);
      delete waitCallbacks[index];
    }
  });

  const res = {
    ws,
    send,
    next,
    skip,
    messages,
    inspector,
    error: undefined as Error | undefined,
  };

  const connectPromise = new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(res));
    ws.addEventListener("error", (error) => {
      // @ts-expect-error
      res.error = error;
      resolve(res);
    });
  });

  return Object.assign(connectPromise, res) as Promise<{
    ws: WebSocket;
    send: (data: any) => Promise<void>;
    next: () => Promise<any>;
    skip: (count?: number) => void;
    messages: unknown[];
    inspector: WebSocketInspector;
    error?: Error;
  }>;
}

class WebSocketInspector extends Agent {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  error?: Error;

  _normalizeHeaders(
    headers: Record<string, string | string[]> | null,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    if (!headers) return out;
    for (const [key, value] of Object.entries(headers)) {
      out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
    }
    return out;
  }

  override dispatch(opts: any, handler: any): boolean {
    // eslint-disable-next-line @typescript-eslint/no-this-alias, unicorn/no-this-assignment
    const inspector = this;
    const wrapped = Object.create(handler);
    wrapped.onResponseStart = function (
      controller: any,
      statusCode: number,
      headers: Record<string, string | string[]>,
      statusText: string,
    ) {
      inspector.status = statusCode;
      inspector.statusText = statusText;
      inspector.headers = inspector._normalizeHeaders(headers);
      return handler.onResponseStart?.(
        controller,
        statusCode,
        headers,
        statusText,
      );
    };
    wrapped.onResponseError = function (controller: any, error: Error) {
      inspector.error = error;
      return handler.onResponseError?.(controller, error);
    };
    wrapped.onRequestUpgrade = function (
      controller: any,
      statusCode: number,
      headers: Record<string, string | string[]>,
      socket: unknown,
    ) {
      inspector.status = statusCode;
      inspector.headers = inspector._normalizeHeaders(headers);
      return handler.onRequestUpgrade?.(
        controller,
        statusCode,
        headers,
        socket,
      );
    };
    return super.dispatch(opts, wrapped);
  }
}

export function wsTestsExec(
  cmd: string,
  opts: Parameters<typeof wsTests>[1] & { silent?: boolean },
  tests = wsTests,
): void {
  let childProc: ExecaRes;
  let url: string;
  beforeAll(async () => {
    const port = await getRandomPort("localhost");
    url = `ws://localhost:${port}/`;
    const [bin, ...args] = cmd
      .replace("$PORT", String(port))
      .replace("./", fixtureDir + "/")
      .split(" ");
    childProc = execa(bin!, args, { env: { PORT: port.toString() } });
    childProc.catch((error) => {
      if (error.signal !== "SIGTERM") {
        console.error(error);
      }
    });
    if (process.env.TEST_DEBUG || !opts.silent) {
      childProc.stderr!.on("data", (chunk) => {
        console.log(chunk.toString());
      });
    }
    if (process.env.TEST_DEBUG) {
      childProc.stdout!.on("data", (chunk) => {
        console.log(chunk.toString());
      });
    }
    await waitForPort(port, { host: "localhost", delay: 50, retries: 100 });
  });
  afterAll(async () => {
    await childProc.kill();
  });
  tests(() => url, opts);
}
