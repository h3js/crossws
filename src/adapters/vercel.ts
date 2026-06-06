import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { NodeRequest } from "srvx/node";
import type { Adapter } from "../adapter.ts";
import nodeAdapter, { type NodeAdapter, type NodeOptions } from "./node.ts";

// --- types ---

export interface VercelAdapter extends Omit<NodeAdapter, "handleUpgrade"> {
  /**
   * Handle a WebSocket upgrade from a Web `Request` (fetch-style handlers).
   *
   * Returns a `204` {@link Response} when the upgrade was handled, or
   * `undefined` when the request is not a WebSocket upgrade or Vercel's upgrade
   * context is unavailable.
   */
  handleWebUpgrade(request: Request): Promise<Response | undefined>;
  /**
   * Handle a WebSocket upgrade from a Node.js `IncomingMessage` (Node-style
   * handlers).
   *
   * Returns `true` when the upgrade was handled (and ends `res` with `204`), or
   * `false` when the request is not a WebSocket upgrade or Vercel's upgrade
   * context is unavailable.
   */
  handleNodeUpgrade(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

export interface VercelOptions extends NodeOptions {}

interface VercelUpgrade {
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
}

interface VercelRequestContext {
  upgradeWebSocket?: () => VercelUpgrade | undefined;
}

// --- adapter ---

const VERCEL_REQUEST_CONTEXT_SYMBOL = Symbol.for("@vercel/request-context");

const vercelAdapter: Adapter<VercelAdapter, VercelOptions> = (options = {}) => {
  const node = nodeAdapter(options);

  // Web path: receives a `Request`, returns a `Response`.
  async function handleWebUpgrade(request: Request): Promise<Response | undefined> {
    if (request.method !== "GET" || !isWebSocketUpgrade(request.headers.get("upgrade"))) {
      return undefined;
    }

    const upgrade = getVercelUpgrade();
    if (!upgrade) {
      return undefined;
    }

    if (typeof request.url === "string") {
      upgrade.req.url = toNodeRequestURL(request.url);
    }

    await performUpgrade(node, upgrade);

    return new Response(null, { status: 204 });
  }

  // Node path: receives an `IncomingMessage`/`ServerResponse`, returns a boolean.
  async function handleNodeUpgrade(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (req.method !== "GET" || !isWebSocketUpgrade(getNodeHeader(req, "upgrade"))) {
      return false;
    }

    const upgrade = getVercelUpgrade();
    if (!upgrade) {
      return false;
    }

    if (typeof req.url === "string") {
      upgrade.req.url = toNodeRequestURL(req.url);
    }

    await performUpgrade(node, upgrade, res);

    if (!res.headersSent && !res.writableEnded) {
      res.statusCode = 204;
      res.end();
    }

    return true;
  }

  return {
    ...node,
    handleWebUpgrade,
    handleNodeUpgrade,
  };
};

export default vercelAdapter;

// --- shared upgrade handling ---

async function performUpgrade(
  node: NodeAdapter,
  upgrade: VercelUpgrade,
  res?: ServerResponse,
): Promise<void> {
  await node.handleUpgrade(
    upgrade.req,
    upgrade.socket,
    upgrade.head,
    new NodeRequest({
      req: upgrade.req,
      res,
      // @ts-expect-error (upgrade is not typed by srvx yet)
      upgrade: {
        socket: upgrade.socket,
        head: upgrade.head,
      },
    }),
  );
}

function getVercelUpgrade(): VercelUpgrade | undefined {
  const upgrade = getVercelRequestContext()?.upgradeWebSocket?.();
  return isVercelUpgrade(upgrade) ? upgrade : undefined;
}

function getVercelRequestContext(): VercelRequestContext | undefined {
  const store = (globalThis as Record<symbol, unknown>)[VERCEL_REQUEST_CONTEXT_SYMBOL] as
    | { get?: () => unknown }
    | undefined;
  if (typeof store?.get !== "function") {
    return;
  }
  const context = store.get();
  if (!context || typeof context !== "object") {
    return;
  }
  return context as VercelRequestContext;
}

function isVercelUpgrade(upgrade: unknown): upgrade is VercelUpgrade {
  if (!upgrade || typeof upgrade !== "object") {
    return false;
  }
  const candidate = upgrade as Partial<VercelUpgrade>;
  return Boolean(candidate.req && candidate.socket && candidate.head);
}

function isWebSocketUpgrade(upgradeHeader: string | undefined | null): boolean {
  return upgradeHeader?.toLowerCase() === "websocket";
}

function getNodeHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(", ") : value;
}

function toNodeRequestURL(url: string): string {
  if (!url) {
    return "/";
  }
  if (url[0] === "/") {
    return url;
  }
  if (/^https?:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      return parsed.pathname + parsed.search;
    } catch {
      return url;
    }
  }
  return url;
}
