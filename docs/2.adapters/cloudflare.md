---
icon: devicon-plain:cloudflareworkers
---

# Cloudflare

> Integrate crossws with Cloudflare Workers and Durable Objects.

To integrate crossws with Cloudflare [Durable Objects](https://developers.cloudflare.com/durable-objects/api/websockets/) with [pub/sub](/guide/pubsub) and [hibernation API](https://developers.cloudflare.com/durable-objects/best-practices/websockets/#websocket-hibernation-api) support, you need to check for the `upgrade` header and additionally export a DurableObject with crossws adapter hooks integrated.

> [!NOTE]
> If you skip durable object class export or in cases the binding is unavailable, crossws uses a **fallback mode** without pub/sub support in the same worker.

```js
import { DurableObject } from "cloudflare:workers";
import crossws from "crossws/adapters/cloudflare";

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

  webSocketPublish(topic, message, opts) {
    return ws.handleDurablePublish(this, topic, message, opts);
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
See [`test/fixture/cloudflare-durable.ts`](https://github.com/h3js/crossws/blob/main/test/fixture/cloudflare-durable.ts) for demo and [`src/adapters/cloudflare.ts`](https://github.com/h3js/crossws/blob/main/src/adapters/cloudflare.ts) for implementation.
::

## Durable Objects
By default, the cloudflare adapter uses a single Durable Object (DO) to handle ALL requests. This behavior will create a bottleneck since DOs are design to scale horizontally and only handle about 1000 requests/s see [DO message throughput limits](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/#message-throughput-limits). To address this, you can use the `useNamespaceAsId` option along with the [`upgrade() hook`](/guide/hooks) to control which DO handle which request.

There are two scenarios for this:

1. You only enable `useNamespaceAsId`. In this case, a DO will be created to handle the request based on the `URL().pathname`.

2. You only enable `useNamespaceAsId` and use the upgrade hook in your route to return an object with a `namespace` property. Here you gain full control over the DO creation. The namespace to get the DO instance id.

> [!NOTE]
> When you enable the `useNamespaceAsId` option, your `upgrade()` hook will run twice!. First it will run on the worker to check if you have returned a `namespace`. Then it will run on the DO once the connection is passed to it. You can use the second argument of the `upgrade()` hook which contains the upgrade context. 
>```ts
>type UpgradeContext = {
>  cf?: {
>    runtime: "worker" | "DO";
>  };
>};
>```

## Adapter options

> [!NOTE]
> By default, crossws uses the durable object class `$DurableObject` from `env` with an instance named `crossws`.
> You can customize this behavior by providing `resolveDurableStub` option.

- `bindingName`: Durable Object binding name from environment (default: `$DurableObject`).
- `instanceName`: Durable Object instance name (default: `crossws`).
- `useNamespaceAsId`: When set to `true`, each peer namespace gets its own Durable Object (default: `false`).
- `resolveDurableStub`: Custom function that resolves Durable Object binding to handle the WebSocket upgrade. This option will override `bindingName` and `instanceName`.
