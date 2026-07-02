import { describe, expect, test } from "vitest";
import { execa } from "execa";
import { fileURLToPath } from "node:url";

// Coverage for the runtime-specific `crossws/websocket` wrappers. Each fixture
// spawns a real Deno/Bun process that dials a `ws+unix:` upstream through the
// wrapper's constructor and prints `WRAPPER_OK` on a successful echo round-trip.
const fixtureDir = fileURLToPath(new URL("fixture", import.meta.url));

function wrapperSuite(runtime: string, cmd: string) {
  describe(`crossws/websocket ws+unix (${runtime})`, () => {
    test("dials a unix-socket upstream via the runtime wrapper", async () => {
      const [bin, ...args] = cmd.replace("./", `${fixtureDir}/`).split(" ");
      const result = await execa(bin!, args, { reject: false });
      if (process.env.TEST_DEBUG) {
        console.log(result.stdout, result.stderr);
      }
      expect(result.stdout).toContain("WRAPPER_OK");
      expect(result.exitCode).toBe(0);
    }, 20_000);
  });
}

wrapperSuite("deno", "deno run --unstable-byonm --unstable-net -A ./ws-unix.deno.ts");
wrapperSuite("bun", "bun run ./ws-unix.bun.ts");
