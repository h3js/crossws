// You can run this demo using `npm run play:cf` in repo
import type {
  ExecutionContext,
  Response as CFResponse,
} from "@cloudflare/workers-types";
import cloudflareAdapter from "../../src/adapters/cloudflare.ts";
import { createDemo, getIndexHTML, handleDemoRoutes } from "./_shared.ts";

const ws = createDemo(cloudflareAdapter);

export default {
  async fetch(
    request: Request,
    env: Record<string, any>,
    context: ExecutionContext,
  ): Promise<Response | CFResponse> {
    const response = handleDemoRoutes(ws, request);
    if (response) {
      return response;
    }

    if (request.headers.get("upgrade") === "websocket") {
      return ws.handleUpgrade(request as any, env, context);
    }

    return new Response(await getIndexHTML(), {
      headers: { "content-type": "text/html" },
    });
  },
};
