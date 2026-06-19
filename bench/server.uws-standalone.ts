// Bench baseline — uWebSockets.js STANDALONE (raw uWS, NO crossws adapter).
// Run: node ./server.uws-standalone.ts   (or `pnpm server:uws-standalone`)
//
// The control for the `node-uws` row: same chat-room semantics as shared.ts
// (join one room, broadcast every message to everyone including the sender) but
// wired straight onto uWebSockets.js with no dependency on crossws. Comparing it
// against `node-uws` (same runtime + library, via the crossws uws adapter)
// isolates the adapter's overhead.

import { App } from "uWebSockets.js";

const port = Number.parseInt(process.env.PORT || "", 10) || 4001;

// uWS `publish` delivers to all subscribers *except* the sender, so we also
// `send` back to the sender — matching crossws's `peer.send + peer.publish`.
App()
  .ws("/*", {
    open(ws) {
      ws.subscribe("room");
      ws.send("ready"); // resolves the client's connect promise
    },
    message(ws, message, isBinary) {
      ws.send(message, isBinary); // echo to the sender ...
      ws.publish("room", message, isBinary); // ... and fan out to everyone else
    },
  })
  .get("/*", (res) => {
    res.cork(() => {
      res.writeStatus("426 Upgrade Required").end("websocket only");
    });
  })
  .listen(port, (token) => {
    if (token) {
      console.log(`[uws-standalone] bench server listening on :${port}`);
    } else {
      console.error(`[uws-standalone] failed to listen on :${port}`);
      process.exit(1);
    }
  });
