// You can run this demo using `npm run play:cf-durable` in repo
import { DurableObject } from "cloudflare:workers";
import cloudflareAdapter from "../../src/adapters/cloudflare.ts";
import { createDemo, getIndexHTML, handleDemoRoutes } from "./_shared.ts";

const ws = createDemo(cloudflareAdapter);

export default {
  async fetch(
    request: Request,
    env: Record<string, any>,
    context: ExecutionContext,
  ): Promise<Response> {
    const response = handleDemoRoutes(ws, request);
    if (response) {
      return response;
    }

    if (request.headers.get("upgrade") === "websocket") {
      return ws.handleUpgrade(request, env, context);
    }

    return new Response(await getIndexHTML(), {
      headers: { "content-type": "text/html" },
    });
  },
};

export class $DurableObject extends DurableObject {
  constructor(state: DurableObjectState, env: Record<string, any>) {
    super(state, env);
    ws.handleDurableInit(this, state, env);
  }

  override fetch(request: Request): Promise<Response> {
    return ws.handleDurableUpgrade(this, request);
  }

  webSocketPublish(topic: string, message: unknown, opts: any) {
    return ws.handleDurablePublish(this, topic, message, opts);
  }

  override async webSocketMessage(
    client: WebSocket,
    message: ArrayBuffer | string,
  ): Promise<void> {
    return ws.handleDurableMessage(this, client, message);
  }

  override async webSocketClose(
    client: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    return ws.handleDurableClose(this, client, code, reason, wasClean);
  }
}
