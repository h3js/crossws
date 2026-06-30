// Cross-adapter bench runner.
//
// For every adapter whose runtime is available on this machine, it:
//   1. boots the matching crossws bench server,
//   2. waits until the port accepts connections,
//   3. runs the universal client against it,
//   4. parses the __BENCH_RESULT__ line, then kills the server,
// and finally prints a side-by-side comparison table.
//
// Usage:
//   node ./run.mjs                      # run every available adapter
//   node ./run.mjs node-ws bun          # run a subset
//   CLIENTS_COUNT=64 RUNS=6 node ./run.mjs

import { spawn } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));

// Resolve deps the way the servers actually import them (walks up every parent
// node_modules), so monorepo/hoisted installs are detected — not just a single
// hardcoded path.
const require = createRequire(import.meta.url);
const canResolve = (id) => {
  try {
    require.resolve(id);
    return true;
  } catch {
    return false;
  }
};
const hasUws = canResolve("uWebSockets.js");
const hasWs = canResolve("ws");

const PORT = Number.parseInt(process.env.PORT || "", 10) || 4001;
const HOST = "127.0.0.1";

// Node 24+ runs the TypeScript servers directly via native type stripping.
const nodeTs = (file) => [process.execPath, [join(here, file)]];

// Resolve the wrangler CLI from wherever it's installed (monorepo-friendly).
const wranglerCmd = () => {
  const pkg = require.resolve("wrangler/package.json");
  const bin = join(dirname(pkg), "bin", "wrangler.js");
  return [
    process.execPath,
    [bin, "dev", "-c", join(here, "wrangler.bench.toml"), "--ip", HOST, "--port", String(PORT)],
  ];
};

// Adapter matrix. A row runs only if its runtime/deps are available on this machine.
// `ready` overrides the port-wait timeout (wrangler/workerd is slow to boot);
// `env` adds per-adapter environment for the server process.
const ADAPTERS = [
  { label: "node-ws", cmd: () => nodeTs("server.node-ws.ts"), probe: () => true },
  {
    label: "node-ws-standalone",
    cmd: () => nodeTs("server.node-ws-standalone.ts"),
    probe: () => hasWs,
  },
  { label: "node-uws", cmd: () => nodeTs("server.node-uws.ts"), probe: () => hasUws },
  { label: "uws-standalone", cmd: () => nodeTs("server.uws-standalone.ts"), probe: () => hasUws },
  { label: "bun", cmd: () => ["bun", [join(here, "server.bun.ts")]], probe: () => onPath("bun") },
  {
    label: "bun-native",
    cmd: () => ["bun", [join(here, "server.bun-native.ts")]],
    probe: () => onPath("bun"),
  },
  {
    label: "deno",
    cmd: () => ["deno", ["run", "-A", join(here, "server.deno.ts")]],
    probe: () => onPath("deno"),
  },
  {
    label: "deno-native",
    cmd: () => ["deno", ["run", "-A", join(here, "server.deno-native.ts")]],
    probe: () => onPath("deno"),
  },
  {
    label: "cloudflare",
    cmd: wranglerCmd,
    probe: () => canResolve("wrangler/package.json"),
    ready: 120_000,
    env: { CI: "1", WRANGLER_SEND_METRICS: "false" },
  },
];

const selected = process.argv.slice(2);
const matrix = ADAPTERS.filter((a) => (selected.length ? selected.includes(a.label) : true));

const results = [];
for (const adapter of matrix) {
  if (!adapter.probe()) {
    console.log(`\n=== ${adapter.label}: SKIPPED (runtime not found) ===`);
    continue;
  }
  console.log(`\n=== ${adapter.label} ===`);
  try {
    results.push(await runOne(adapter));
  } catch (error) {
    console.error(`${adapter.label} failed:`, error?.message || error);
  }
}

printTable(results);
process.exit(0);

// --- helpers ---------------------------------------------------------------

async function runOne(adapter) {
  const [bin, args] = normalize(adapter.cmd());
  const server = spawn(bin, args, {
    cwd: here,
    env: { ...process.env, ...adapter.env, PORT: String(PORT) },
    stdio: ["ignore", "inherit", "inherit"],
    detached: true, // own process group, so we can kill child workerd/etc. too
  });

  try {
    await waitForPort(HOST, PORT, adapter.ready ?? 15_000);
    return await runClient(adapter.label);
  } finally {
    try {
      process.kill(-server.pid, "SIGKILL"); // kill the whole group
    } catch {
      server.kill("SIGKILL");
    }
    await waitForPortClosed(HOST, PORT, 8000);
  }
}

function runClient(label) {
  return new Promise((resolve, reject) => {
    const client = spawn(process.execPath, [join(here, "client.mjs")], {
      cwd: here,
      env: { ...process.env, SERVER: `ws://${HOST}:${PORT}`, LABEL: label },
      stdio: ["ignore", "pipe", "inherit"],
    });

    let buf = "";
    let result;
    client.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      process.stdout.write(text);
      buf += text;
      const line = buf.split("\n").find((l) => l.startsWith("__BENCH_RESULT__"));
      if (line) result = JSON.parse(line.slice("__BENCH_RESULT__".length).trim());
    });
    client.on("error", reject);
    client.on("exit", (code) => {
      if (result) resolve(result);
      else reject(new Error(`client exited (code ${code}) without a result`));
    });
  });
}

function waitForPort(host, port, timeout) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = connect({ host, port }, () => {
        sock.destroy();
        resolve();
      });
      sock.on("error", () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error(`port ${port} not ready in ${timeout}ms`));
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

function waitForPortClosed(host, port, timeout) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve) => {
    const attempt = () => {
      const sock = connect({ host, port }, () => {
        sock.destroy();
        if (Date.now() > deadline) resolve();
        else setTimeout(attempt, 150);
      });
      sock.on("error", () => {
        sock.destroy();
        resolve();
      });
    };
    attempt();
  });
}

function onPath(bin) {
  const dirs = (process.env.PATH || "").split(":");
  return dirs.some((d) => d && existsSync(join(d, bin)));
}

function normalize(cmd) {
  // cmd() returns [bin, arg] or [bin, [args...]]
  const [bin, rest] = cmd;
  return [bin, Array.isArray(rest) ? rest : [rest]];
}

function printTable(results) {
  console.log("\n\n================ crossws cross-adapter results ================");
  if (results.length === 0) {
    console.log("(no results)");
    return;
  }
  const clients = results[0]?.clients;
  console.log(`clients: ${clients}, messages/batch: 640, metric: received messages/sec\n`);

  const rows = [...results].sort((a, b) => b.median - a.median);
  const fastest = rows[0].median;
  const head = ["adapter", "median/s", "mean/s", "max/s", "connect(ms)", "rel"];
  const data = rows.map((r) => [
    r.label,
    r.median.toLocaleString(),
    r.mean.toLocaleString(),
    r.max.toLocaleString(),
    String(r.connectMs),
    (r.median / fastest).toFixed(2) + "x",
  ]);

  const widths = head.map((h, i) => Math.max(h.length, ...data.map((row) => row[i].length)));
  const fmt = (row) => row.map((c, i) => c.padEnd(widths[i])).join("  ");
  console.log(fmt(head));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of data) console.log(fmt(row));
  console.log();
}
