---
icon: simple-icons:vercel
---

# Vercel

> Integrate crossws with Vercel Functions that expose WebSocket upgrades.

The Vercel adapter uses Vercel's request context to access the raw Node.js upgrade request, socket, and head. That platform detail stays private inside the adapter, so applications can keep using the normal crossws hooks API.

## Fetch-style handlers

Use this form from runtimes that receive a Web `Request` and return a `Response`.

```ts
import crossws from "crossws/adapters/vercel";

const ws = crossws({
  hooks: {
    open(peer) {
      peer.send("hello");
    },
  },
});

export default {
  async fetch(request) {
    const response = await ws.handleUpgrade(request);
    if (response) {
      return response;
    }

    return new Response("ok");
  },
};
```

## Node-style handlers

Use this form from Vercel Node.js handlers that receive an `IncomingMessage` and `ServerResponse`.

```ts
import crossws from "crossws/adapters/vercel";

const ws = crossws({
  hooks: {
    message(peer, message) {
      peer.send(message.text());
    },
  },
});

export default async function handler(req, res) {
  if (await ws.handleUpgrade(req, res)) {
    return;
  }

  res.end("ok");
}
```

The adapter returns `undefined` or `false` when the request is not a WebSocket upgrade or when Vercel's upgrade context is unavailable. When a WebSocket upgrade is handled, the returned fetch response or Node response status is `204`; the WebSocket handshake itself is completed on the raw upgrade socket.

::read-more
See [`test/adapters/vercel.test.ts`](https://github.com/h3js/crossws/blob/main/test/adapters/vercel.test.ts) for a local simulation and [`src/adapters/vercel.ts`](https://github.com/h3js/crossws/blob/main/src/adapters/vercel.ts) for implementation.
::
