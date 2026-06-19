// crossws bench server — Node.js + uWebSockets.js (crossws uws adapter)
// Run: node ./server.node-uws.ts   (or `pnpm server:node-uws`)

import { App } from "uWebSockets.js";
import uwsAdapter from "../src/adapters/uws.ts";
import { createBench, getPort } from "./shared.ts";

const ws = createBench(uwsAdapter);
const port = getPort();

App()
  .ws("/*", ws.websocket)
  .get("/*", (res) => {
    res.cork(() => {
      res.writeStatus("426 Upgrade Required").end("websocket only");
    });
  })
  .listen(port, (token) => {
    if (token) {
      console.log(`[uws] crossws bench server listening on :${port}`);
    } else {
      console.error(`[uws] failed to listen on :${port}`);
      process.exit(1);
    }
  });
