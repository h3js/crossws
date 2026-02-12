````mdc
---
icon: simple-icons:bunny
---

# Bunny

> Manually integrate crossws with Bunny.net Edge Scripting.

> [!TIP]
> You can use `serve` function from `crossws/server/bunny` to **automatically** integrate crossws with Bunny.net!

[Bunny.net Edge Scripting](https://docs.bunny.net/scripting/websockets) supports WebSockets to deliver low-latency, bidirectional communication between your applications and users across the globe.

## Usage

To integrate crossws with Bunny.net Edge Scripting, you need to check for the `upgrade` header and then call `handleUpgrade` method from the adapter passing the incoming request object. The returned value is the server upgrade response.

```ts
import * as BunnySDK from "@bunny.net/edgescript-sdk";
import crossws from "crossws/adapters/bunny";

const ws = crossws({
  hooks: {
    message: (peer, message) => {
      console.log("Received:", message.text());
      peer.send(`Echo: ${message.text()}`);
    },
    open: (peer) => {
      console.log("Client connected");
    },
    close: (peer) => {
      console.log("Client disconnected");
    },
  },
});

BunnySDK.net.http.serve(async (request: Request) => {
  if (request.headers.get("upgrade") === "websocket") {
    return ws.handleUpgrade(request);
  }

  return new Response(
    `<script>new WebSocket("wss://your-domain.b-cdn.net").addEventListener("open", (e) => e.target.send("Hello from client!"));</script>`,
    { headers: { "content-type": "text/html" } },
  );
});
```

## Protocol Negotiation

You can control WebSocket protocol negotiation through the `upgrade` hook by setting the `sec-websocket-protocol` header. This is useful for implementing authorization or selecting specific subprotocols based on the request:

```ts
const ws = crossws({
  hooks: {
    upgrade(req) {
      // Check for authorization token
      const token = req.headers.get("authorization");
      if (!token) {
        return new Response("Unauthorized", { status: 401 });
      }

      // Negotiate protocol based on client request
      const requestedProtocol = req.headers.get("sec-websocket-protocol");
      const supportedProtocols = ["graphql-ws", "graphql-transport-ws"];

      const protocol = requestedProtocol
        ?.split(",")
        .map((p) => p.trim())
        .find((p) => supportedProtocols.includes(p));

      return {
        headers: {
          "sec-websocket-protocol": protocol || "",
        },
      };
    },
  },
});
```

## Options

The Bunny adapter supports the following options:

### `protocol`

The WebSocket subprotocol to use for the connection.

> [!NOTE]
> This can be overridden by setting the `sec-websocket-protocol` header in the `upgrade` hook for dynamic protocol negotiation.

```ts
const ws = crossws({
  protocol: "graphql-ws",
});
```

### `idleTimeout`

The number of seconds to wait for a pong response before closing the connection. Defaults to `30`.

If the client does not respond within this timeout, the connection is deemed unhealthy and closed. If no data is transmitted from the client for 2 minutes, the connection will be closed regardless of this configuration.

```ts
const ws = crossws({
  idleTimeout: 60,
});
```

::read-more
See [Bunny.net WebSocket Documentation](https://docs.bunny.net/scripting/websockets) for more details on the WebSocket API.
::

::read-more
See [`src/adapters/bunny.ts`](https://github.com/h3js/crossws/blob/main/src/adapters/bunny.ts) for implementation.
::

````
