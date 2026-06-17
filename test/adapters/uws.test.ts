import { afterAll, beforeAll, describe } from "vitest";
import { getRandomPort, waitForPort } from "get-port-please";
import { App, type TemplatedApp } from "uWebSockets.js";
import uwsAdapter from "../../src/adapters/uws";
import { createDemo } from "../fixture/_shared";
import { wsTests } from "../tests";

describe("uws", () => {
  let app: TemplatedApp;
  let url: string;

  beforeAll(async () => {
    const ws = createDemo(uwsAdapter);

    app = App().ws("/*", ws.websocket);

    app.get("/*", async (res, req) => {
      let aborted = false;
      res.onAborted(() => {
        aborted = true;
      });

      let resBody = "OK";
      const url = req.getUrl();
      if (url === "/peers") {
        resBody = JSON.stringify({
          peers: [...ws.peers].flatMap(([namespace, peers]) =>
            [...peers].map((p) => `${namespace}:${p.id}`),
          ),
        });
      } else if (url === "/publish") {
        const q = new URLSearchParams(req.getQuery());
        const topic = q.get("topic") || "";
        const message = q.get("message") || "";
        if (topic && message) {
          ws.publish(topic, message);
          resBody = "published";
        }
      }

      if (aborted) {
        return;
      }
      res.cork(() => {
        res.writeStatus("200 OK");
        res.end(resBody);
      });
    });

    const port = await getRandomPort("localhost");
    url = `ws://localhost:${port}/`;
    await new Promise<void>((resolve) => app.listen(port, () => resolve()));
    await waitForPort(port);
  });

  afterAll(() => {
    app.close();
  });

  wsTests(() => url, {
    adapter: "uws",
  });
});
