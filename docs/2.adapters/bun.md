---
icon: simple-icons:bun
---

# Bun

> Integrate crossws with Bun.

To integrate crossws with your Bun server, you need to handle upgrade with `handleUpgrade` util and also pass the `websocket` object returned from the adapter to server options. crossws leverages native bun [WebSocket API](https://bun.sh/docs/api/websockets).

```ts
import crossws from "crossws/adapters/bun";

const ws = crossws({
  hooks: {
    message: console.log,
  },
});

Bun.serve({
  port: 3000,
  websocket: ws.websocket,
  fetch(request, server) {
    if (request.headers.get("upgrade") === "websocket") {
      return ws.handleUpgrade(request, server);
    }
    return new Response(
      `<script>new WebSocket("ws://localhost:3000").addEventListener('open', (e) => e.target.send("Hello from client!"));</script>`,
      { headers: { "content-type": "text/html" } },
    );
  },
});
```

::read-more
See [`test/fixture/bun.ts`](https://github.com/h3js/crossws/blob/main/test/fixture/bun.ts) for demo and [`src/adapters/bun.ts`](https://github.com/h3js/crossws/blob/main/src/adapters/bun.ts) for implementation.
::
