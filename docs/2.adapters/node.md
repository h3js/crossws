---
icon: akar-icons:node-fill
---

# Node.js

> Integrate crossws with Node.js (manually) or uWebSockets.js

> [!TIP]
> You can use `serve` function from `crossws/server` to **automatically** integrate crossws with Node.js!

To manually integrate crossws with your Node.js HTTP server, you need to connect the `upgrade` event to the `handleUpgrade` method returned from the adapter. crossws uses a prebundled version of [ws](https://github.com/websockets/ws).

```ts
import { createServer } from "node:http";
import crossws from "crossws/adapters/node";

const ws = crossws({
  hooks: {
    message: console.log,
  },
});

const server = createServer((req, res) => {
  res.end(
    `<script>new WebSocket("ws://localhost:3000").addEventListener('open', (e) => e.target.send("Hello from client!"));</script>`,
  );
}).listen(3000);

server.on("upgrade", (req, socket, head) => {
  if (req.headers.upgrade === "websocket") {
    ws.handleUpgrade(req, socket, head);
  }
});
```

::read-more
See [`test/fixture/node.ts`](https://github.com/h3js/crossws/blob/main/test/fixture/node.ts) for demo and [`src/adapters/node.ts`](https://github.com/h3js/crossws/blob/main/src/adapters/node.ts) for implementation.
::

## Delegating to an existing Node.js upgrade handler

If you already have a Node.js WebSocket library that exposes a raw `(req, socket, head)` upgrade handler (e.g. [`ws`](https://github.com/websockets/ws), `socket.io`, `express-ws`), you can route to it through crossws using `fromNodeUpgradeHandler`. This lets you keep crossws's upgrade-time request handling while delegating the WebSocket lifecycle to your existing library.

```ts
import { WebSocketServer } from "ws";
import { fromNodeUpgradeHandler } from "crossws/adapters/node";
import { serve } from "crossws/server/node";

const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (ws) => {
  ws.on("message", (data) => ws.send(data));
});

serve({
  fetch: () => new Response("ok"),
  websocket: fromNodeUpgradeHandler((req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  }),
});
```

The underlying handler takes full ownership of the socket, so crossws's other lifecycle hooks (`open`, `message`, `close`, `error`) are **not** invoked for connections routed through it — manage the WebSocket lifecycle inside your own library as usual.

> [!NOTE]
> `fromNodeUpgradeHandler` only works on the Node.js runtime, and must be used via the crossws node server plugin so the request carries `runtime.node.upgrade.{socket, head}`.

## uWebSockets

You can alternatively use [uWebSockets.js](https://github.com/uNetworking/uWebSockets.js) for Node.js servers.

First add `uNetworking/uWebSockets.js` as a dependency.

```ts
import { App } from "uWebSockets.js";
import crossws from "crossws/adapters/uws";

const ws = crossws({
  hooks: {
    message: console.log,
  },
});

const server = App().ws("/*", ws.websocket);

server.get("/*", (res, req) => {
  res.writeStatus("200 OK").writeHeader("Content-Type", "text/html");
  res.end(
    `<script>new WebSocket("ws://localhost:3000").addEventListener('open', (e) => e.target.send("Hello from client!"));</script>`,
  );
});

server.listen(3001, () => {
  console.log("Listening to port 3001");
});
```

::read-more
See [`test/fixture/node-uws.ts`](https://github.com/h3js/crossws/blob/main/test/fixture/node-uws.ts) for demo and [`src/adapters/node-uws.ts`](https://github.com/h3js/crossws/blob/main/src/adapters/node-uws.ts) for implementation.
::
