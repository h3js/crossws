import { WebSocket as WsWebSocket } from "ws";

// `crossws/websocket` entry for Node.
//
// Node's native global `WebSocket` (undici) dials `ws:`/`wss:` but rejects the
// `ws+unix:` scheme, reads its dialing options only from the constructor's
// *second* argument (ignoring a third), and is absent on Node < 22. The `ws`
// client supports the `ws+unix:` scheme and honors the WHATWG/`ws` third
// options argument — where the proxy passes custom upgrade `headers` and other
// `ws` dialing options. So route through `ws` when a third options argument is
// present, for the `ws+unix:` scheme, or when there is no global; the native
// global stays on the common option-less `ws:`/`wss:` path. This keeps the
// `(url, protocols, options)` signature consistent with the Bun/Deno wrappers.
// The `Proxy` keeps the native constructor's static members (`WebSocket.OPEN`,
// …) intact.
const _global = globalThis.WebSocket as typeof globalThis.WebSocket | undefined;

const NodeWebSocket: typeof globalThis.WebSocket = _global
  ? new Proxy(_global, {
      construct(target, args) {
        const url = args[0] as string | URL | undefined;
        const href = typeof url === "string" ? url : (url?.href ?? "");
        const useWs = href.startsWith("ws+unix:") || args[2] != null;
        const Ctor = useWs ? (WsWebSocket as unknown as typeof _global) : target;
        return Reflect.construct(Ctor, args);
      },
    })
  : (WsWebSocket as unknown as typeof globalThis.WebSocket);

export default NodeWebSocket;
