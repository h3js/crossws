---
icon: akar-icons:node-fill
---

# Node.js

> Integrate crossws with Node.js using ws or uWebSockets.js

To integrate crossws with your Node.js HTTP server, you need to connect the `upgrade` event to the `handleUpgrade` method returned from the adapter. crossws uses a prebundled version of [ws](https://github.com/websockets/ws).

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
