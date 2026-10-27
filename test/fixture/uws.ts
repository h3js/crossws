// You can run this demo using `npm run play:node-uws` in repo

import { App } from "uWebSockets.js";
import uwsAdapter from "../../src/adapters/uws";
import { createDemo, getIndexHTML } from "./_shared.ts";

const ws = createDemo(uwsAdapter);

const app = App().ws("/*", ws.websocket);

app.get("/*", async (res, _req) => {
  let aborted = false;
  res.onAborted(() => {
    aborted = true;
  });
  const html = await getIndexHTML();
  if (aborted) {
    return;
  }
  res.cork(() => {
    res.writeStatus("200 OK");
    res.writeHeader("Content-Type", "text/html");
    res.end(html);
  });
});

const port = Number(process.env.PORT) || 3001;

app.listen(port, () => {
  console.log(`Listening to port ${port}`);
});
