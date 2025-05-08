import type * as web from "../types/web.ts";
import { kNodeInspect } from "./utils.ts";

export interface AdapterInternal {
  ws: unknown;
  request: Request;
  peers?: Set<Peer>;
  context?: Peer["context"];
}

export abstract class Peer<Internal extends AdapterInternal = AdapterInternal> {
  protected _internal: Internal;
  protected _topics: Set<string>;
  protected _id?: string;

  #ws?: Partial<web.WebSocket>;

  constructor(internal: Internal) {
    this._topics = new Set();
    this._internal = internal;
  }

  get context(): Record<string, unknown> {
    return (this._internal.context ??= {});
  }

  /**
   * Unique random [uuid v4](https://developer.mozilla.org/en-US/docs/Glossary/UUID) identifier for the peer.
   */
  get id(): string {
    if (!this._id) {
      this._id = crypto.randomUUID();
    }
    return this._id;
  }

  /** IP address of the peer */
  get remoteAddress(): string | undefined {
    return undefined;
  }

  /** upgrade request */
  get request(): Request {
    return this._internal.request;
  }

  /**
   * Get the [WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket) instance.
   *
   * **Note:** crossws adds polyfill for the following properties if native values are not available:
   * - `protocol`: Extracted from the `sec-websocket-protocol` header.
   * - `extensions`: Extracted from the `sec-websocket-extensions` header.
   * - `url`: Extracted from the request URL (http -> ws).
   * */
  get websocket(): Partial<web.WebSocket> {
    if (!this.#ws) {
      const _ws = this._internal.ws as Partial<web.WebSocket>;
      const _request = this._internal.request;
      this.#ws = _request ? createWsProxy(_ws, _request) : _ws;
    }
    return this.#ws;
  }

  /** All connected peers to the server */
  get peers(): Set<Peer> {
    return this._internal.peers || new Set();
  }

  /** All topics, this peer has been subscribed to. */
  get topics(): Set<string> {
    return this._topics;
  }

  abstract close(code?: number, reason?: string): void;

  /** Abruptly close the connection */
  terminate(): void {
    this.close();
  }

  /** Subscribe to a topic */
  subscribe(topic: string): void {
    this._topics.add(topic);
  }

  /** Unsubscribe from a topic */
  unsubscribe(topic: string): void {
    this._topics.delete(topic);
  }

  /** Send a message to the peer. */
  abstract send(
    data: unknown,
    options?: { compress?: boolean },
  ): number | void | undefined;

  /** Send message to subscribes of topic */
  abstract publish(
    topic: string,
    data: unknown,
    options?: { compress?: boolean },
  ): void;

  // --- inspect ---

  toString(): string {
    return this.id;
  }

  [Symbol.toPrimitive](): string {
    return this.id;
  }

  [Symbol.toStringTag](): "WebSocket" {
    return "WebSocket";
  }

  [kNodeInspect](): Record<string, unknown> {
    return Object.fromEntries(
      [
        ["id", this.id],
        ["remoteAddress", this.remoteAddress],
        ["peers", this.peers],
        ["webSocket", this.websocket],
      ].filter((p) => p[1]),
    );
  }
}

function createWsProxy(
  ws: Partial<web.WebSocket>,
  request: Partial<Request>,
): Partial<web.WebSocket> {
  return new Proxy(ws, {
    get: (target, prop) => {
      const value = Reflect.get(target, prop);
      if (!value) {
        switch (prop) {
          case "protocol": {
            return request?.headers?.get("sec-websocket-protocol") || "";
          }
          case "extensions": {
            return request?.headers?.get("sec-websocket-extensions") || "";
          }
          case "url": {
            return request?.url?.replace(/^http/, "ws") || undefined;
          }
        }
      }
      return value;
    },
  });
}
