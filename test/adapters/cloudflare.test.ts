import { describe } from "vitest";
import { wsTestsExec } from "../_utils";

describe("cloudflare", () => {
  wsTestsExec(
    "wrangler dev -c ./wrangler.toml --inspector-port 0 --port $PORT",
    { adapter: "cloudflare", pubsub: false, silent: true },
  );
});

describe("cloudflare-durable", () => {
  wsTestsExec(
    "wrangler dev -c ./wrangler-durable.toml --inspector-port 0 --port $PORT",
    { adapter: "cloudflare-durable" },
  );
});
