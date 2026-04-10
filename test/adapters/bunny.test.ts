import { describe, test, expect } from "vitest";

describe("bunny", () => {
  // TODO: Implement tests when Bunny.net edge scripting environment becomes available for local testing
  // The adapter can be tested manually by deploying to Bunny.net edge environment

  test("adapter module exports", async () => {
    const bunnyAdapter = await import("../../src/adapters/bunny.ts");
    expect(bunnyAdapter.default).toBeDefined();
    expect(typeof bunnyAdapter.default).toBe("function");
  });
});
