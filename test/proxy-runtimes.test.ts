import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { execa, type ResultPromise } from "execa";
import { fileURLToPath } from "node:url";
import { getRandomPort, waitForPort } from "get-port-please";
import { wsConnect } from "./_utils.ts";

// Cross-runtime coverage for out-of-the-box `ws+unix:` proxying. Node is covered
// in-process by proxy.test.ts; here we spawn real Deno and Bun processes running
// a fixture that proxies (over TCP) to an echo upstream bound to a unix socket,
// exercising each runtime's native dialing strategy end to end.
const fixtureDir = fileURLToPath(new URL("fixture", import.meta.url));

function unixProxySuite(runtime: string, cmd: string) {
  describe(`proxy unix (${runtime})`, () => {
    let child: ResultPromise | undefined;
    let url: string;

    beforeAll(async () => {
      const port = await getRandomPort("localhost");
      url = `ws://localhost:${port}/`;
      const [bin, ...args] = cmd.replace("./", `${fixtureDir}/`).split(" ");
      child = execa(bin!, args, { env: { PORT: String(port) } });
      child.catch((error) => {
        if (error.signal !== "SIGTERM") {
          console.error(error);
        }
      });
      if (process.env.TEST_DEBUG) {
        child.stderr?.on("data", (chunk) => console.log(chunk.toString()));
        child.stdout?.on("data", (chunk) => console.log(chunk.toString()));
      }
      await waitForPort(port, { host: "localhost", delay: 50, retries: 100 });
    });

    afterAll(async () => {
      await child?.kill();
    });

    test("proxies text frames to the unix-socket upstream", async () => {
      const ws = await wsConnect(url);
      await ws.send("hello");
      expect(await ws.next()).toBe("echo:hello");
    });
  });
}

unixProxySuite("deno", "deno run --unstable-byonm --unstable-net -A ./proxy-unix.deno.ts");
unixProxySuite("bun", "bun run ./proxy-unix.bun.ts");
