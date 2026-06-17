import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { execa } from "execa";
import { wsTestsExec } from "../_utils";

describe("bun", () => {
  wsTestsExec("bun run ./bun.ts", { adapter: "bun" });

  test("sync relays channels across instances", async () => {
    const fixture = fileURLToPath(new URL("../fixture/bun-sync.ts", import.meta.url));
    const result = await execa("bun", ["run", fixture], { reject: false });
    expect(result.stdout, result.stderr).toContain("bun sync ok");
    expect(result.exitCode).toBe(0);
  });
});
