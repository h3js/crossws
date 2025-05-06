---
icon: devicon-plain:cloudflareworkers
---

# Cloudflare

> Integrate crossws with Cloudflare Workers.

To integrate crossws with your Cloudflare Workers, you need to check for the `upgrade` header.

> [!IMPORTANT]
> For [pub/sub](/guide/pubsub) support, you need to use [Durable objects](#durable-objects).

```ts
import crossws from "crossws/adapters/cloudflare";

const ws = crossws({
  hooks: {
    message: console.log,
  },
});

export default {
  async fetch(request, env, context) {
    if (request.headers.get("upgrade") === "websocket") {
      return ws.handleUpgrade(request, env, context);
    }
    return new Response(
      `<script>new WebSocket("ws://localhost:3000").addEventListener("open", (e) => e.target.send("Hello from client!"));</script>`,
      { headers: { "content-type": "text/html" } },
    );
  },
};
```

::read-more
See [`test/fixture/cloudflare.ts`](https://github.com/h3js/crossws/blob/main/test/fixture/cloudflare.ts) for demo and [`src/adapters/cloudflare.ts`](https://github.com/h3js/crossws/blob/main/src/adapters/cloudflare.ts) for implementation.
::

## Durable objects

To integrate crossws with Cloudflare [Durable Objects](https://developers.cloudflare.com/durable-objects/api/websockets/) (available on paid plans) with pub/sub and hibernation support, you need to check for the `upgrade` header and additionally export a Durable object with crossws adapter hooks integrated.

```js
import { DurableObject } from "cloudflare:workers";
import crossws from "crossws/adapters/cloudflare-durable";

const ws = crossws({
  // bindingName: "$DurableObject",
  // instanceName: "crossws",
  hooks: {
    message: console.log,
    open(peer) {
      peer.subscribe("chat");
      peer.publish("chat", { user: "server", message: `${peer} joined!` });
    },
  },
});

export default {
  async fetch(request, env, context) {
    if (request.headers.get("upgrade") === "websocket") {
      return ws.handleUpgrade(request, env, context);
    }
    return new Response(
      `<script>new WebSocket("ws://localhost:3000").addEventListener("open", (e) => e.target.send("Hello from client!"));</script>`,
      { headers: { "content-type": "text/html" } },
    );
  },
};

export class $DurableObject extends DurableObject {
  constructor(state, env) {
    super(state, env);
    ws.handleDurableInit(this, state, env);
  }

  fetch(request) {
    return ws.handleDurableUpgrade(this, request);
  }

  webSocketMessage(client, message) {
    return ws.handleDurableMessage(this, client, message);
  }

  webSocketClose(client, code, reason, wasClean) {
    return ws.handleDurableClose(this, client, code, reason, wasClean);
  }
}
```

Update your `wrangler.toml` to specify Durable object:

```ini
[[durable_objects.bindings]]
name = "$DurableObject"
class_name = "$DurableObject"

[[migrations]]
tag = "v1"
new_classes = ["$DurableObject"]
```

::read-more
See [`test/fixture/cloudflare-durable.ts`](https://github.com/h3js/crossws/blob/main/test/fixture/cloudflare-durable.ts) for demo and [`src/adapters/cloudflare-durable.ts`](https://github.com/h3js/crossws/blob/main/src/adapters/cloudflare-durable.ts) for implementation.
::

### Adapter options

> [!NOTE]
> By default, crossws uses the durable object class `$DurableObject` from `env` with an instance named `crossws`.
> You can customize this behavior by providing `resolveDurableStub` option.

- `bindingName`: Durable Object binding name from environment (default: `$DurableObject`).
- `instanceName`: Durable Object instance name (default: `crossws`).
- `resolveDurableStub`: Custom function that resolves Durable Object binding to handle the WebSocket upgrade. This option will override `bindingName` and `instanceName`.
