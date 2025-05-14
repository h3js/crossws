import {
  type Adapter,
  type AdapterInstance,
  defineHooks,
} from "../../src/index.ts";

export const getIndexHTML = (opts?: { sse?: boolean }): Promise<string> =>
  import("./_index.html.ts").then((r) => r.default(opts));

export function createDemo<T extends Adapter<any, any>>(
  adapter: T,
  options?: Parameters<T>[0],
): ReturnType<T> {
  const hooks = defineHooks({
    open(peer) {
      peer.send(`Welcome to the server ${peer}!`);
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
        case "peers": {
          peer.send({
            peers: [...peer.peers].map((p) => p.id),
          });
          break;
        }
        default: {
          peer.send(msgText);
          peer.publish("chat", msgText);
        }
      }
    },
    upgrade(req) {
      if (req.url.endsWith("?unauthorized")) {
        throw {
          get response() {
            return new Response("unauthorized", {
              status: 401,
              statusText: "Unauthorized",
              headers: { "x-error": "unauthorized" },
            });
          },
        };
      }
      req.context!.test = "1";
      return {
        headers: {
          "x-powered-by": "cross-ws",
          "set-cookie": "cross-ws=1; SameSite=None; Secure",
        },
      };
    },
  });

  return adapter({
    ...options,
    hooks,
  });
}

export function handleDemoRoutes(
  ws: AdapterInstance,
  request: Request,
): Response | undefined {
  const url = new URL(request.url);
  if (url.pathname === "/peers") {
    return new Response(
      JSON.stringify({
        peers: [...ws.peers].map((p) => p.id),
      }),
    );
  } else if (url.pathname === "/publish") {
    const topic = url.searchParams.get("topic") || "";
    const message = url.searchParams.get("message") || "";
    ws.publish(topic, message);
    return new Response("published");
  }
}
