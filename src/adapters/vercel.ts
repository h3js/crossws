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
  const wss = nodeAdapter(options);

  // Web path: receives a `Request`, returns a `Response`.
  async function handleWebUpgrade(request: Request): Promise<Response | undefined> {
    if (!_isWsUpgrade(request.method, request.headers.get("upgrade") || undefined)) {
      return undefined;
    }

    const upgrade = _getVercelUpgrade();
    if (!upgrade) {
      return undefined;
    }

    await wss.handleUpgrade(upgrade.req, upgrade.socket, upgrade.head, request);

    return new Response(null, { status: 204 });
  }

  // Node path: receives an `IncomingMessage`/`ServerResponse`, returns a boolean.
  async function handleNodeUpgrade(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (!_isWsUpgrade(req.method, req.headers.upgrade)) {
      return false;
    }

    const upgrade = _getVercelUpgrade();
    if (!upgrade) {
      return false;
    }

    await wss.handleUpgrade(
      upgrade.req,
      upgrade.socket,
      upgrade.head,
      new NodeRequest({ req, res }),
    );

    if (!res.headersSent && !res.writableEnded) {
      res.statusCode = 204;
      res.end();
    }

    return true;
  }

  const { handleUpgrade: _, ...rest } = wss;
  return {
    ...rest,
    handleWebUpgrade,
    handleNodeUpgrade,
  };
};

export default vercelAdapter;

function _isWsUpgrade(method: string | undefined, upgradeHeader: string | undefined): boolean {
  return method === "GET" && upgradeHeader?.toLowerCase?.() === "websocket";
}

function _getVercelUpgrade(): VercelUpgrade | undefined {
  const upgrade = _getVercelRequestContext()?.upgradeWebSocket?.() as
    | Partial<VercelUpgrade>
    | undefined;
  return upgrade?.req && upgrade?.socket && upgrade?.head ? (upgrade as VercelUpgrade) : undefined;
}

function _getVercelRequestContext(): VercelRequestContext | undefined {
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
