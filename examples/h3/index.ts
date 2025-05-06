import { createApp } from "h3";
import { defineHooks } from "crossws";

export const app = createApp();

// Listhen automatically sets up integration!
// Learn more: https://crossws.h3.dev

export const websocket = {
  hooks: defineHooks({
    open(peer) {
      console.log("[ws] open", peer);
      peer.send({ user: "server", message: `Welcome ${peer}!` });
    },

    message(peer, message) {
      console.log("[ws] message", peer, message);
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
  }),
};
