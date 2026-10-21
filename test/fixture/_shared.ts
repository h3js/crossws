import { type Adapter, type AdapterInstance, defineHooks } from "../../src/index.ts";

export const getIndexHTML = (opts?: { sse?: boolean }): Promise<string> =>
  import("./_index.html.ts").then((r) => r.default(opts));

// The `close` hook's details per peer id, served at `/close-details?peer=<id>`.
const closeDetails = new Map<string, { code?: number; reason?: string }>();

export function createDemo<T extends Adapter<any, any>>(
  adapter: T,
  options?: Parameters<T>[0],
): ReturnType<T> {
  const hooks = defineHooks({
    open(peer) {
      peer.send(`Welcome to the server ${peer}! (namespace: ${peer.namespace})`);
      peer.subscribe("chat");
      peer.publish("chat", `${peer} joined!`);
    },
    message(peer, message) {
      const msgText = message.text();
      switch (msgText) {
        case "ping": {
          peer.send("pong");
          break;
        }
        case "binary": {
          peer.send(new TextEncoder().encode("binary message works!"));
          break;
        }
        case "debug": {
          peer.send({
            id: peer.id,
            remoteAddress: peer.remoteAddress,
            bufferedAmount: peer.bufferedAmount,
            context: peer.context,
            request: {
              url: peer.request?.url,
              headers: Object.fromEntries(peer.request?.headers || []),
            },
            websocket: {
              readyState: peer.websocket.readyState,
              protocol: peer.websocket.protocol,
              extensions: peer.websocket.extensions,
              url: peer.websocket.url,
              binaryType: peer.websocket.binaryType,
              bufferedAmount: peer.websocket.bufferedAmount,
            },
          });
          break;
        }
        case "waitForDrain": {
          peer.waitForDrain({ pollInterval: 10 }).then(() => peer.send("drained"));
          break;
        }
        case "peers": {
          peer.send({
            peers: [...peer.peers].map((p) => p.id),
          });
          break;
        }
        case "ping-me": {
          peer.ping("server-ping");
          break;
        }
        default: {
          peer.send(msgText);
          peer.publish("chat", msgText);
        }
      }
    },
    close(peer, details) {
      closeDetails.set(peer.id, { code: details.code, reason: details.reason });
    },
    ping(peer, data) {
      peer.send(`ping-received:${new TextDecoder().decode(data)}`);
    },
    pong(peer, data) {
      peer.send(`pong-received:${new TextDecoder().decode(data)}`);
    },
    upgrade(req) {
      if (req.url.endsWith("?unauthorized")) {
        throw {
          get response() {
            return new Response("unauthorized", {
              status: 401,
              statusText: "Unauthorized",
              headers: {
                "x-error": "unauthorized",
                "www-authenticate": 'Bearer realm="crossws"',
              },
            });
          },
        };
      }
      const headers: Record<string, string> = {
        "x-powered-by": "cross-ws",
        "set-cookie": "cross-ws=1; SameSite=None; Secure",
      };
      const reqProtocol = req.headers.get("sec-websocket-protocol");
      // Negotiate via a header set directly by the hook (the original way).
      if (reqProtocol === "supported") {
        headers["sec-websocket-protocol"] = "supported";
      }
      const result: {
        context: Record<string, string>;
        headers: Record<string, string>;
        protocol?: string;
      } = {
        context: { test: "1" },
        headers,
      };
      // Negotiate via the first-class per-connection `protocol` return field.
      if (reqProtocol === "graphql-transport-ws") {
        result.protocol = "graphql-transport-ws";
      }
      return result;
    },
  });

  return adapter({
    ...options,
    hooks,
    // Global default selector: negotiate via the `handleProtocols` option.
    handleProtocols: (protocols: Set<string>) => (protocols.has("chat") ? "chat" : false),
  });
}

export function handleDemoRoutes(ws: AdapterInstance, request: Request): Response | undefined {
  const url = new URL(request.url);
  if (url.pathname === "/peers") {
    return Response.json({
      peers: [...ws.peers].flatMap(([namespace, peers]) =>
        [...peers].map((p) => `${namespace}:${p.id}`),
      ),
    });
  } else if (url.pathname === "/publish") {
    const topic = url.searchParams.get("topic") || "";
    const message = url.searchParams.get("message") || "";
    ws.publish(topic, message);
    return new Response("published");
  } else if (url.pathname === "/close-details") {
    return Response.json(closeDetails.get(url.searchParams.get("peer") || "") ?? null);
  }
}
