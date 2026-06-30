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

### Adapter options

> [!NOTE]
> By default, crossws uses the durable object class `$DurableObject` from `env` with an instance named `crossws`.
> You can customize this behavior by providing `resolveDurableStub` option.

- `bindingName`: Durable Object binding name from environment (default: `$DurableObject`).
- `instanceName`: Durable Object instance name (default: `crossws`).
- `resolveDurableStub`: Custom function that resolves Durable Object binding to handle the WebSocket upgrade. This option will override `bindingName` and `instanceName`.
- `sync`: Optional [sync backplane](/guide/sync) to relay [pub/sub](/guide/pubsub) across instances (see below).
- `onError`: Observe sync backplane failures. See [delivery semantics](/guide/sync#delivery-semantics).

### Sync across instances

The [sync backplane](/guide/sync) relays [pub/sub](/guide/pubsub) between crossws instances, but on Cloudflare the model is different from a Node-style cluster — so reach for it only when you actually need it. A backplane on Cloudflare requires **Durable Objects**: only a Durable Object's context owns its (hibernatable) sockets via `ctx.getWebSockets()` and can fan a message out to them. In **fallback mode** (no Durable Object binding) each connection is a separate Worker invocation that can't send to another connection's socket, so pub/sub — and a backplane — are not supported there.

- **Single Durable Object (the default).** With one instance (`"crossws"`), every connection across your app already lands on that same Durable Object, so `peer.publish()` is cluster-global out of the box. **No backplane needed.**
- **Sharded Durable Objects.** If you fan connections across **multiple** instances (e.g. one per room via `resolveDurableStub`), a publish in one instance won't reach the others — a `sync` backplane bridges them.

```js
import crossws from "crossws/adapters/cloudflare";
import type { SyncAdapter } from "crossws";

const ws = crossws({
  hooks,
  sync: myBackplane, // a custom SyncAdapter (see caveats below)
});
```

Two Cloudflare-specific caveats:

- **Inbound delivery into a Durable Object is best-effort.** crossws seeds the fan-out of a relayed message from the instance's in-memory peer map, which a hibernated/evicted Durable Object loses even though its sockets survive in `ctx.getWebSockets()`. A message relayed _into_ a hibernated Durable Object may miss some sockets. **Outbound** relay — a `peer.publish()` in a Durable Object reaching the backplane — is reliable.
- **Bring a Cloudflare-native driver.** The built-in `redis` / `pgsql` drivers open persistent connections and target Node-like runtimes, so they won't run inside workerd. Write a custom [`SyncAdapter`](/guide/sync#writing-a-driver) over a Cloudflare-native transport (a coordinator Durable Object, [Queues](https://developers.cloudflare.com/queues/), or fetch-based pub/sub) instead.
