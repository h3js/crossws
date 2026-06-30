// crossws bench server — Node.js + `ws` (node:http + crossws node adapter)
// Run: node ./server.node-ws.ts   (or `pnpm server:node-ws`)

import { createServer } from "node:http";
import nodeAdapter from "../src/adapters/node.ts";
import { createBench, getPort } from "./shared.ts";

const ws = createBench(nodeAdapter);
const port = getPort();

const server = createServer((_req, res) => {
  res.writeHead(426, { "content-type": "text/plain" });
  res.end("websocket only");
});

server.on("upgrade", ws.handleUpgrade);

server.listen(port, () => {
  console.log(`[node] crossws bench server listening on :${port}`);
});
