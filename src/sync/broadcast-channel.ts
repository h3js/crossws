import type { SyncAdapter, SyncDriver, SyncMessage } from "./types.ts";

/**
 * Zero-dependency sync driver built on [`BroadcastChannel`](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel).
 *
 * Bridges instances that share a `BroadcastChannel` registry. On Node.js, Deno
 * and Bun that registry is scoped to a **single process** (it spans the main
 * thread and its worker threads), so this is for in-process worker fan-out and
 * tests — not separate OS processes (e.g. Node `cluster`/PM2 forks), which each
 * have an isolated registry and will silently not sync. (Deno Deploy is the one
 * exception: its `BroadcastChannel` spans isolates.)
 *
 * For multiple processes, hosts or regions you want a networked driver such as
 * {@link redis} or {@link pgsql}.
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
          const envelope = event.data as { id?: string; msg?: SyncMessage } | undefined;
          // Ignore our own echo and anything that isn't a well-formed crossws
          // envelope (a foreign writer may share the channel name). Validate the
          // shape before deliver() — unlike the text drivers there's no
          // decodeEnvelope here to reject malformed payloads.
          if (!envelope || envelope.id === id || typeof envelope.msg?.topic !== "string") {
            return;
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
