import type { SyncAdapter, SyncDriver, SyncMessage } from "./types.ts";

/**
 * Zero-dependency sync driver built on [`BroadcastChannel`](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel).
 *
 * Works across worker threads / processes that share a `BroadcastChannel`
 * implementation (Node.js, Deno and Bun). Great for tests and single-host multi-worker deployments.
 *
 * For multi-region you want a networked driver such as {@link redis}.
 *
 * A `channel` name is required: it scopes the cluster, and a shared default
 * would risk silently bridging unrelated servers running on the same host.
 *
 * @example
 * ```js
 * import { broadcastChannel } from "crossws/sync";
 * const adapter = nodeAdapter({ hooks, sync: broadcastChannel({ channel: "my-app" }) });
 * ```
 */
export function broadcastChannel(opts: { channel: string }): SyncAdapter {
  return ({ id }) => {
    const channel = new BroadcastChannel(opts.channel);
    return {
      subscribe(deliver) {
        channel.addEventListener("message", (event: MessageEvent) => {
          const envelope = event.data as { id: string; msg: SyncMessage };
          if (!envelope || envelope.id === id) {
            return; // ignore malformed and our own messages
          }
          deliver(envelope.msg);
        });
      },
      publish(msg) {
        channel.postMessage({ id, msg });
      },
      close() {
        channel.close();
      },
    } satisfies SyncDriver;
  };
}
