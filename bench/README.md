# crossws cross-adapter WebSocket benchmark

A simple but very active **chat room** throughput benchmark, run across every
crossws adapter. Inspired by
[`oven-sh/bun` › `bench/websocket-server`](https://github.com/oven-sh/bun/tree/main/bench/websocket-server)
and kept methodologically compatible so numbers are comparable.

The point of crossws is that you write your WebSocket logic **once** and run it
on any runtime. This bench leans into that: the entire chat-room app lives in a
single [`shared.ts`](./shared.ts) hooks definition, and each `server.*.ts` file
just plugs it into a different adapter:

| Adapter              | Server file                                                      | Runtime                      | How it runs    |
| -------------------- | ---------------------------------------------------------------- | ---------------------------- | -------------- |
| `node-ws`            | [`server.node-ws.ts`](./server.node-ws.ts)                       | Node.js (`ws` / `node:http`) | native (TS)    |
| `node-ws-standalone` | [`server.node-ws-standalone.ts`](./server.node-ws-standalone.ts) | Node.js (`ws`)               | native (TS)    |
| `node-uws`           | [`server.node-uws.ts`](./server.node-uws.ts)                     | Node.js (`uWebSockets.js`)   | native (TS)    |
| `uws-standalone`     | [`server.uws-standalone.ts`](./server.uws-standalone.ts)         | Node.js (`uWebSockets.js`)   | native (TS)    |
| `bun`                | [`server.bun.ts`](./server.bun.ts)                               | Bun (`Bun.serve`)            | native         |
| `bun-native`         | [`server.bun-native.ts`](./server.bun-native.ts)                 | Bun (`Bun.serve`)            | native         |
| `deno`               | [`server.deno.ts`](./server.deno.ts)                             | Deno (`Deno.serve`)          | native         |
| `deno-native`        | [`server.deno-native.ts`](./server.deno-native.ts)               | Deno (`Deno.serve`)          | native         |
| `cloudflare`         | [`server.cloudflare.ts`](./server.cloudflare.ts)                 | Cloudflare (workerd)         | `wrangler dev` |

Differences in the results therefore reflect the runtime + adapter, **not** the
application code.

> **The `*-native` / `*-standalone` rows are controls.** Each reproduces the same
> chat-room semantics with **no crossws at all**, straight on the underlying API:
> `node-ws-standalone` (`ws`), `uws-standalone` (uWebSockets.js), `bun-native`
> (`Bun.serve`), `deno-native` (`Deno.serve`). Comparing a control against its
> crossws sibling on the same runtime (`node-ws`, `node-uws`, `bun`, `deno`)
> shows the adapter's overhead.

## What it measures

Every client joins one room. Each client repeatedly sends a fixed list of 640
messages; the server broadcasts every message to **all** clients (including the
sender). A client waits for the full broadcast fan-out before sending the next
batch. The reported metric is **received messages/second**, sampled over 10
one-second windows (the first window is dropped as warm-up in the summary).

With `N` clients, one batch produces `N × 640 × N` delivered messages.

## Quick start

From this directory (deps come from the repo root — run `pnpm install` there
first):

```sh
# Run every adapter whose runtime is installed, then print a comparison table
node ./run.mjs

# Only a subset
node ./run.mjs bun node-ws

# Tune the load
CLIENTS_COUNT=64 RUNS=10 node ./run.mjs
```

The runner boots each server, waits for its port, runs the client against it,
records the result, and kills the server before moving on — so only one adapter
is measured at a time.

### Running a single adapter manually

Start a server (it listens on `PORT`, default `4001`):

```sh
pnpm server:node-ws             # or: node ./server.node-ws.ts
pnpm server:node-ws-standalone  # or: node ./server.node-ws-standalone.ts
pnpm server:node-uws            # or: node ./server.node-uws.ts
pnpm server:uws-standalone      # or: node ./server.uws-standalone.ts
pnpm server:bun                 # or: bun ./server.bun.ts
pnpm server:bun-native          # or: bun ./server.bun-native.ts
pnpm server:deno                # or: deno run -A ./server.deno.ts
pnpm server:deno-native         # or: deno run -A ./server.deno-native.ts
pnpm server:cloudflare          # or: wrangler dev -c wrangler.bench.toml
```

Then point the universal client at it (runs on Node, Bun, or Deno):

```sh
node ./client.mjs            # bun ./client.mjs  /  deno run -A ./client.mjs
```

## Configuration (env vars)

| Var             | Default               | Applies to     | Meaning                           |
| --------------- | --------------------- | -------------- | --------------------------------- |
| `PORT`          | `4001`                | server, runner | Listen port                       |
| `SERVER`        | `ws://127.0.0.1:4001` | client         | Server URL                        |
| `CLIENTS_COUNT` | `32`                  | client, runner | Number of concurrent clients      |
| `RUNS`          | `10`                  | client         | Number of 1-second sample windows |
| `LABEL`         | `""`                  | client         | Prefix tag in client output       |
| `LOG_MESSAGES`  | `0`                   | client         | Log every received message        |

## Example output

```
================ crossws cross-adapter results ================
clients: 32, messages/batch: 640, metric: received messages/sec

adapter             median/s  mean/s  max/s  connect(ms)  rel
------------------  --------  ------  -----  -----------  -----
bun                 ...       ...     ...    ...          1.00x
bun-native          ...       ...     ...    ...          ...
node-uws            ...       ...     ...    ...          ...
uws-standalone      ...       ...     ...    ...          ...
deno                ...       ...     ...    ...          ...
deno-native         ...       ...     ...    ...          ...
node-ws             ...       ...     ...    ...          ...
node-ws-standalone  ...       ...     ...    ...          ...
cloudflare          ...       ...     ...    ...          ...
```

Absolute numbers depend heavily on hardware, runtime versions, and client
count — always compare adapters from the **same** run on the **same** machine.

## Notes

- The `node-*` servers run TypeScript directly on Node 24+ (native type
  stripping), so no `jiti`/transpile step is needed.
- Each row is skipped automatically when its runtime/deps are missing: `bun` /
  `deno` need those binaries on `PATH`; `node-uws` needs `uWebSockets.js`;
  `cloudflare` needs `wrangler` (all three are already devDependencies in the
  workspace root, resolved via real module resolution wherever they're hoisted).
- The `cloudflare` row runs the worker locally with `wrangler dev` (workerd).
  Cross-peer pub/sub on Cloudflare **requires a Durable Object**, so
  [`server.cloudflare.ts`](./server.cloudflare.ts) defines one and routes every
  connection into it. It boots much slower than the others (the runner allows up
  to 120s) and goes over wrangler's local proxy, so treat its number as
  indicative of the local-dev path, not bare workerd.
- Vercel, Bunny and the SSE adapter are intentionally omitted — they target
  serverless or a different transport and don't fit this "single long-lived
  process on localhost" harness.
- The client mirrors Bun's reference `chat-client.mjs` so this suite can be
  compared against the upstream non-crossws baselines.
