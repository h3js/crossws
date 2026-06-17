---
icon: teenyicons:deno-solid
---

# Deno

> Manually integrate crossws with Deno.

> [!TIP]
> You can use `serve` function from `crossws/server` to **automatically** integrate crossws with Deno!

To manually integrate crossws with your Deno server, you need to check for the `upgrade` header and then call `handleUpgrade` method from the adapter passing the incoming request object. The returned value is the server upgrade response.

```ts
import crossws from "crossws/adapters/deno";

const ws = crossws({
  hooks: {
    message: console.log,
  },
});

Deno.serve({ port: 3000 }, (request, info) => {
  if (request.headers.get("upgrade") === "websocket") {
    return ws.handleUpgrade(request, info);
  }
  return new Response(
    `<script>new WebSocket("ws://localhost:3000").addEventListener("open", (e) => e.target.send("Hello from client!"));</script>`,
    { headers: { "content-type": "text/html" } },
  );
});
```

::read-more
See [`test/fixture/deno.ts`](./test/fixture/deno.ts) for demo and [`src/adapters/deno.ts`](./src/adapters/deno.ts) for implementation.
::
