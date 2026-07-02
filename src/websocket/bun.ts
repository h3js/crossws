// `crossws/websocket` entry for Bun.
//
// Bun's global `WebSocket` dials `ws:`, `wss:`, and `ws+unix:` natively, so no
// wrapping is needed — this re-exports the global as the Bun runtime entry
// (kept as a dedicated file for parity with the Node/Deno wrappers).
const WebSocket: typeof globalThis.WebSocket = globalThis.WebSocket;

export default WebSocket;
