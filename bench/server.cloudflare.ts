// crossws bench server — Cloudflare Workers (workerd, via `wrangler dev`).
// Run: wrangler dev -c wrangler.bench.toml   (or `pnpm server:cloudflare`)
//
// The bench is a broadcast chat room, and on Cloudflare cross-peer pub/sub
// requires a Durable Object (the plain-Worker fallback explicitly does not
// support publish). So this defines a single `$DurableObject` that every
// connection is routed into — modeled on test/fixture/cloudflare-durable.ts.

import { DurableObject } from "cloudflare:workers";
import cloudflareAdapter from "../src/adapters/cloudflare.ts";
import { createBench } from "./shared.ts";

const ws = createBench(cloudflareAdapter);

export default {
  async fetch(request: Request, env: Record<string, any>, context: any): Promise<Response> {
    if (request.headers.get("upgrade") === "websocket") {
      return ws.handleUpgrade(request as any, env, context);
    }
    return new Response("websocket only", { status: 426 });
  },
};

export class $DurableObject extends DurableObject {
  constructor(state: any, env: Record<string, any>) {
    super(state, env);
    ws.handleDurableInit(this, state, env);
  }

  override fetch(request: Request): Promise<Response> {
    return ws.handleDurableUpgrade(this, request as any) as Promise<Response>;
  }

  webSocketPublish(topic: string, message: unknown, opts: any) {
    return ws.handleDurablePublish(this, topic, message, opts);
  }

  override webSocketMessage(client: any, message: ArrayBuffer | string): Promise<void> {
    return ws.handleDurableMessage(this, client, message);
  }

  override webSocketClose(
    client: any,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    return ws.handleDurableClose(this, client, code, reason, wasClean);
  }
}
