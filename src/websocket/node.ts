import { WebSocket as _WebSocket } from "ws";

const Websocket: typeof globalThis.WebSocket = globalThis.WebSocket || _WebSocket;

export default Websocket;
