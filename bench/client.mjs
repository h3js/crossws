// Universal chat-room load client. Runs on Node, Bun, or Deno.
//
// Adapted from oven-sh/bun `bench/websocket-server/chat-client.mjs` so results
// are directly comparable to that reference benchmark. It connects N clients to
// a single room, then repeatedly blasts a fixed message list from every client
// and waits for the full broadcast fan-out before sending the next batch,
// reporting received messages/second over 10 one-second windows.

const env = "Deno" in globalThis ? Deno.env.toObject() : "process" in globalThis ? process.env : {};

const SERVER = env.SERVER || "ws://127.0.0.1:4001";
const LABEL = env.LABEL || "";
const WebSocketImpl = globalThis.WebSocket || (await import("ws")).WebSocket;
const LOG_MESSAGES = env.LOG_MESSAGES === "1";
const CLIENTS_TO_WAIT_FOR = Number.parseInt(env.CLIENTS_COUNT || "", 10) || 32;
const RUNS = Number.parseInt(env.RUNS || "", 10) || 10;
const DELAY = 64;

const MESSAGES_TO_SEND = Array.from({ length: 32 }, () => [
  "Hello World!",
  "Hello World! 1",
  "Hello World! 2",
  "Hello World! 3",
  "Hello World! 4",
  "Hello World! 5",
  "Hello World! 6",
  "Hello World! 7",
  "Hello World! 8",
  "Hello World! 9",
  "What is the meaning of life?",
  "where is the bathroom?",
  "zoo",
  "kangaroo",
  "erlang",
  "elixir",
  "bun",
  "mochi",
  "typescript",
  "javascript",
]).flat();

const NAMES = Array.from({ length: 64 }, (_, i) => [
  "Alice" + i,
  "Bob" + i,
  "Charlie" + i,
  "David" + i,
  "Eve" + i,
  "Frank" + i,
  "Grace" + i,
  "Heidi" + i,
])
  .flat()
  .slice(0, CLIENTS_TO_WAIT_FOR);

const tag = LABEL ? `[${LABEL}] ` : "";

console.log(`${tag}Connecting ${CLIENTS_TO_WAIT_FOR} WebSocket clients to ${SERVER} ...`);
const connectStart = nowMs();

const clients = Array.from({ length: CLIENTS_TO_WAIT_FOR });
const connectPromises = [];
for (let i = 0; i < CLIENTS_TO_WAIT_FOR; i++) {
  clients[i] = new WebSocketImpl(`${SERVER}?name=${NAMES[i]}`);
  connectPromises.push(
    new Promise((resolve, reject) => {
      clients[i].onmessage = () => resolve();
      clients[i].onerror = (err) => reject(err?.error || err || new Error("ws error"));
    }),
  );
}

await Promise.all(connectPromises);
const connectMs = +(nowMs() - connectStart).toFixed(1);
console.log(`${tag}All ${CLIENTS_TO_WAIT_FOR} clients connected in ${connectMs}ms`);

let received = 0;
let total = 0;
let more = false;
let remaining;
let bailed = false;

// A dropped connection mid-run would leave `remaining` stuck above 0 forever:
// the fan-out never completes, no restart fires, and the remaining windows
// silently report ~0 — producing a bogus (low) number instead of an error.
// Guard against it: fail loudly and exit non-zero so the runner records the
// adapter as failed rather than logging a meaningless result.
function bail(reason) {
  if (bailed) return;
  bailed = true;
  clearInterval(reportTimer);
  clearInterval(restartTimer);
  console.error(`${tag}ABORTED — ${reason} (no result emitted)`);
  for (const c of clients) {
    try {
      c.close();
    } catch {}
  }
  exit(1);
}

for (let i = 0; i < CLIENTS_TO_WAIT_FOR; i++) {
  clients[i].onmessage = (event) => {
    if (LOG_MESSAGES) console.log(event.data);
    received++;
    remaining--;
    if (remaining === 0) {
      more = true;
      remaining = total;
    }
  };
  clients[i].onerror = (err) => bail(`client ${i} errored: ${err?.message || err?.error || err}`);
  clients[i].onclose = () => bail(`client ${i} closed unexpectedly`);
}

// Every message sent by every client is delivered to every client.
total = CLIENTS_TO_WAIT_FOR * MESSAGES_TO_SEND.length * CLIENTS_TO_WAIT_FOR;
remaining = total;

function restart() {
  for (let i = 0; i < CLIENTS_TO_WAIT_FOR; i++) {
    for (let j = 0; j < MESSAGES_TO_SEND.length; j++) {
      clients[i].send(MESSAGES_TO_SEND[j]);
    }
  }
}

const runs = [];
const reportTimer = setInterval(() => {
  const last = received;
  runs.push(last);
  received = 0;
  console.log(
    `${tag}${last.toLocaleString()} messages/sec ` +
      `(${CLIENTS_TO_WAIT_FOR} clients x ${MESSAGES_TO_SEND.length} msg, min delay ${DELAY}ms)`,
  );

  if (runs.length >= RUNS) {
    finish();
  }
}, 1000);

let isRestarting = false;
const restartTimer = setInterval(() => {
  if (more && !isRestarting) {
    more = false;
    isRestarting = true;
    restart();
    isRestarting = false;
  }
}, DELAY);

restart();

function finish() {
  bailed = true; // intentional shutdown — don't let the closing sockets trip bail()
  clearInterval(reportTimer);
  clearInterval(restartTimer);

  // Drop the first window (warm-up / partial) when computing summary stats.
  const sample = runs.length > 2 ? runs.slice(1) : runs;
  const sorted = [...sample].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = Math.round(sample.reduce((a, b) => a + b, 0) / sample.length);
  const max = Math.max(...sample);
  const min = Math.min(...sample);

  const result = {
    label: LABEL,
    server: SERVER,
    clients: CLIENTS_TO_WAIT_FOR,
    connectMs,
    runs,
    median,
    mean,
    max,
    min,
  };
  console.log(
    `${tag}done — median ${median.toLocaleString()} msg/sec (mean ${mean.toLocaleString()}, max ${max.toLocaleString()})`,
  );
  // Machine-readable line consumed by run.mjs:
  console.log("__BENCH_RESULT__ " + JSON.stringify(result));

  for (const c of clients) {
    try {
      c.close();
    } catch {}
  }
  exit(0);
}

function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function exit(code) {
  if ("process" in globalThis) process.exit(code);
  else if ("Deno" in globalThis) Deno.exit(code);
}
