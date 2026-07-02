import { WebSocket as WsWebSocket } from "ws";

// `crossws/websocket` entry for Node.
//
// Node's native global `WebSocket` (undici) dials `ws:`/`wss:` but rejects the
// `ws+unix:` scheme, and is absent on Node < 22. The `ws` client supports both,
// so route `ws+unix:` — and everything, when there is no global — through `ws`,
// keeping the native global for the common `ws:`/`wss:` path. The `Proxy` keeps
// the native constructor's static members (`WebSocket.OPEN`, …) intact.
const _global = globalThis.WebSocket as typeof globalThis.WebSocket | undefined;

const NodeWebSocket: typeof globalThis.WebSocket = _global
  ? new Proxy(_global, {
      construct(target, args) {
        const url = args[0] as string | URL | undefined;
        const href = typeof url === "string" ? url : (url?.href ?? "");
        const Ctor = href.startsWith("ws+unix:")
          ? (WsWebSocket as unknown as typeof _global)
          : target;
        return Reflect.construct(Ctor, args);
      },
    })
  : (WsWebSocket as unknown as typeof globalThis.WebSocket);

export default NodeWebSocket;
