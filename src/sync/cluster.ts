import type { SyncAdapter, SyncDriver } from "./types.ts";
import { decodeEnvelope, encodeEnvelope } from "./encoding.ts";

// IPC message marker. Forked workers and the primary exchange plain objects over
// `process.send()` / `worker.send()`; this key both tags a crossws relay message
// (so we ignore unrelated IPC the app sends) and carries the channel name for
// per-channel filtering. Its value is the channel; `env` is the wire envelope.
const CLUSTER_MESSAGE = "crossws:sync";

interface ClusterEnvelope {
  [CLUSTER_MESSAGE]: string;
  env: string;
}

function isClusterEnvelope(message: unknown): message is ClusterEnvelope {
  return (
    typeof message === "object" &&
    message !== null &&
    typeof (message as ClusterEnvelope)[CLUSTER_MESSAGE] === "string" &&
    typeof (message as ClusterEnvelope).env === "string"
  );
}

// Guard against installing the relay twice if setupPrimaryCluster() is called
// more than once (e.g. re-imported entry, defensive double-call).
let relayInstalled = false;

/**
 * Install the cluster relay in the **primary** process.
 *
 * Node `cluster` workers can't message each other directly — IPC only flows
 * between each worker and the primary — so the primary must rebroadcast every
 * worker's relay message to the others. Call this once in your primary process
 * (before or after forking) so {@link cluster} drivers running in the workers
 * can reach one another. It is a no-op when called from a worker, so guarding
 * with `cluster.isPrimary` is optional.
 *
 * `node:cluster` is imported lazily so merely importing `crossws/sync` stays
 * runtime-agnostic (it never loads in workerd/Deno where the module is unused).
 *
 * @example
 * ```js
 * import cluster from "node:cluster";
 * import { availableParallelism } from "node:os";
 * import { setupPrimaryCluster } from "crossws/sync";
 *
 * if (cluster.isPrimary) {
 *   setupPrimaryCluster();
 *   for (let i = 0; i < availableParallelism(); i++) cluster.fork();
 * } else {
 *   // ... start your server with `sync: cluster({ channel: "my-app" })`
 * }
 * ```
 */
export async function setupPrimaryCluster(): Promise<void> {
  const cluster = (await import("node:cluster")).default;
  if (!cluster.isPrimary || relayInstalled) {
    return;
  }
  relayInstalled = true;
  cluster.on("message", (_worker, message) => {
    if (!isClusterEnvelope(message)) {
      return;
    }
    // Rebroadcast to every worker, including the sender: the sending driver
    // filters its own echo by instance `id` (same contract as the Redis driver),
    // which also lets two drivers on the same channel in one worker hear each
    // other. Workers never relay, so there is no loop.
    for (const id in cluster.workers) {
      cluster.workers[id]?.send(message);
    }
  });
}

/**
 * Zero-dependency sync driver over Node.js [`cluster`](https://nodejs.org/api/cluster.html)
 * worker IPC — bridges forked processes on a **single host** (e.g. Node
 * `cluster` or PM2 `instances`) without a network backplane.
 *
 * This fills the gap left by {@link broadcastChannel}, whose registry is scoped
 * to one process and silently won't sync across forks. For multiple hosts or
 * regions you still want a networked driver such as {@link redis} or
 * {@link pgsql}.
 *
 * Requires the relay to be installed in the primary via
 * {@link setupPrimaryCluster}; the driver itself runs in the workers. Workers
 * can't message each other directly, so all relay flows worker → primary →
 * workers. Binary payloads are base64-encoded so they survive default JSON IPC
 * serialization (no `serialization: "advanced"` needed).
 *
 * A `channel` name is required: it scopes the cluster and lets multiple apps
 * share one process tree without bridging into each other.
 *
 * @example
 * ```js
 * import cluster from "node:cluster";
 * import { setupPrimaryCluster, cluster as clusterSync } from "crossws/sync";
 *
 * if (cluster.isPrimary) {
 *   setupPrimaryCluster();
 *   cluster.fork();
 *   cluster.fork();
 * } else {
 *   const ws = nodeAdapter({ hooks, sync: clusterSync({ channel: "my-app" }) });
 *   // ... start the server
 * }
 * ```
 */
export function cluster(opts: { channel: string }): SyncAdapter {
  const channel = opts.channel;
  return ({ id }) => {
    // `process` may be absent (e.g. workerd); reference it via globalThis so the
    // module stays importable, and resolve `send` per-call (it only exists on a
    // forked child).
    const proc = globalThis.process;
    let onMessage: ((message: unknown) => void) | undefined;
    return {
      subscribe(deliver) {
        if (typeof proc?.send !== "function") {
          throw new Error(
            "[crossws] cluster sync must run in a worker forked by node:cluster " +
              "(process.send is unavailable). Call setupPrimaryCluster() in the " +
              "primary process and start your server in the workers.",
          );
        }
        onMessage = (message) => {
          if (!isClusterEnvelope(message) || message[CLUSTER_MESSAGE] !== channel) {
            return;
          }
          const envelope = decodeEnvelope(message.env);
          if (!envelope || envelope.id === id) {
            return; // ignore malformed messages and our own echo
          }
          deliver(envelope.msg);
        };
        proc.on("message", onMessage);
      },
      publish(msg) {
        proc?.send?.({ [CLUSTER_MESSAGE]: channel, env: encodeEnvelope(id, msg) });
      },
      close() {
        if (onMessage) {
          proc?.off?.("message", onMessage);
          onMessage = undefined;
        }
      },
    } satisfies SyncDriver;
  };
}
