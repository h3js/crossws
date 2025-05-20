import { Agent, WebSocket as WebSocketUndici } from "undici";
import { afterAll, beforeAll, afterEach } from "vitest";
import { execa, type ResultPromise as ExecaRes } from "execa";
import { fileURLToPath } from "node:url";
import { getRandomPort, waitForPort } from "get-port-please";
import { wsTests } from "./tests";
import type { Peer } from "../src";

const fixtureDir = fileURLToPath(new URL("fixture", import.meta.url));

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
  const _WebSocket = globalThis.WebSocket || WebSocketUndici;
  const ws = new _WebSocket(url, {
    // @ts-expect-error
    headers: opts?.headers,
    dispatcher: inspector,
  });
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
    rawHeaders: string[] | Buffer[] | null,
  ): Record<string, string> {
    const headerEntries: [string, string][] = [];
    for (let i = 0; i < rawHeaders!.length; i += 2) {
      headerEntries.push([
        decodeURIComponent(rawHeaders![i]!.toString()).toLowerCase(),
        decodeURIComponent(rawHeaders![i + 1]!.toString()),
      ]);
    }
    return Object.fromEntries(headerEntries);
  }

  override dispatch(opts: any, handler: any): boolean {
    return super.dispatch(opts, {
      ...handler,
      onHeaders: (statusCode, headers, resume, statusText) => {
        this.status = statusCode;
        this.statusText = statusText;
        this.headers = this._normalizeHeaders(headers);
        return handler.onHeaders(statusCode, headers, resume, statusText);
      },
      onError: (error) => {
        this.error = error;
        return handler.onError(error);
      },
      onUpgrade: (statusCode, rawHeaders = [], socket) => {
        this.headers = this._normalizeHeaders(rawHeaders);
        return handler.onUpgrade(statusCode, rawHeaders, socket);
      },
    });
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
