// Shared crossws hooks used by every adapter server in this bench.
//
// This is the whole point of the benchmark: the chat-room logic is written
// exactly ONCE here, and each `server.<runtime>.ts` file just plugs it into a
// different crossws adapter (node / bun / deno / uws / ...). Any difference in
// the numbers therefore reflects the runtime + adapter, not the app code.
//
// Semantics mirror oven-sh/bun `bench/websocket-server`:
//   - every peer joins a single "room"
//   - every message is broadcast to all peers, including the sender
//     (equivalent to Bun's `publishToSelf: true`)

import { type Adapter, defineHooks } from "../src/index.ts";

export const ROOM = "room";

export function createBench<T extends Adapter<any, any>>(
  adapter: T,
  options?: Parameters<T>[0],
): ReturnType<T> {
  const hooks = defineHooks({
    open(peer) {
      peer.subscribe(ROOM);
      // The client resolves its "connected" promise on the first message it
      // receives, so send one immediately on open.
      peer.send("ready");
    },
    message(peer, message) {
      const out = message.text();
      peer.send(out); // echo to the sender ...
      peer.publish(ROOM, out); // ... and fan out to everyone else
    },
  });

  return adapter({ ...options, hooks });
}

// Cross-runtime PORT lookup (process for node/bun, Deno.env for deno).
export function getPort(fallback = 4001): number {
  const g = globalThis as any;
  const raw = g.Deno?.env?.get?.("PORT") ?? g.process?.env?.PORT ?? "";
  return Number.parseInt(raw, 10) || fallback;
}
