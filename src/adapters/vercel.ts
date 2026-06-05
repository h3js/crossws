import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { NodeRequest } from "srvx/node";
import type { Adapter } from "../adapter.ts";
import nodeAdapter, { type NodeAdapter, type NodeOptions } from "./node.ts";

// --- types ---

export interface VercelAdapter extends Omit<NodeAdapter, "handleUpgrade"> {
  handleUpgrade(request: Request): Promise<Response | undefined>;
  handleUpgrade(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
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

  async function handleUpgrade(request: Request): Promise<Response | undefined>;
  async function handleUpgrade(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  async function handleUpgrade(
    request: Request | IncomingMessage,
    res?: ServerResponse,
  ): Promise<Response | boolean | undefined> {
    const fetchStyle = isWebRequest(request);
    if (!isWebSocketUpgradeRequest(request)) {
      return fetchStyle ? undefined : false;
    }

    const upgrade = getVercelRequestContext()?.upgradeWebSocket?.();
    if (!isVercelUpgrade(upgrade)) {
      return fetchStyle ? undefined : false;
    }

    if (typeof request.url === "string") {
      upgrade.req.url = toNodeRequestURL(request.url);
    }

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

    if (fetchStyle) {
      return new Response(null, { status: 204 });
    }

    if (res && !res.headersSent && !res.writableEnded) {
      res.statusCode = 204;
      res.end();
    }

    return true;
  }

  return {
    ...node,
    handleUpgrade,
  };
};

export default vercelAdapter;

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

function isWebRequest(request: Request | IncomingMessage): request is Request {
  return typeof (request as Request).headers?.get === "function";
}

function isWebSocketUpgradeRequest(request: Request | IncomingMessage): boolean {
  return request.method === "GET" && getHeader(request, "upgrade")?.toLowerCase() === "websocket";
}

function getHeader(request: Request | IncomingMessage, name: string): string | undefined {
  if (isWebRequest(request)) {
    return request.headers.get(name) || undefined;
  }
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(", ") : value;
}

function toNodeRequestURL(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url || "/";
  }
}
