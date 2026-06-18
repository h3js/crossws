import { describe } from "vitest";
import { wsTestsExec } from "../_utils";

describe("bun", () => {
  wsTestsExec("bun run ./bun.ts", { adapter: "bun" });
});
