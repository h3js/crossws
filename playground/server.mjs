// Works with Bun, Deno and Node.js (also Cloudflare or SSE as fallback)
import { serve } from "crossws/server";

serve({
  websocket: {
    open(peer) {
      console.log("[ws] open", peer);
      peer.send({ user: "server", message: `Welcome ${peer}!` });
    },

    message(peer, message) {
      console.log("[ws] message", message);
      if (message.text().includes("ping")) {
        peer.send({ user: "server", message: "pong" });
      } else {
        peer.send({ user: peer.toString(), message: message.toString() });
      }
    },

    close(peer, event) {
      console.log("[ws] close", peer, event);
    },

    error(peer, error) {
      console.log("[ws] error", peer, error);
    },
  },
  fetch: () =>
    fetch(
      "https://raw.githubusercontent.com/h3js/crossws/refs/heads/main/playground/public/index.html",
    ).then(
      (res) =>
        new Response(res.body, { headers: { "Content-Type": "text/html" } }),
    ),
});
