import type * as web from "../types/web.ts";
import { kNodeInspect } from "./utils.ts";

export interface PeerContext extends Record<string, unknown> {}

export interface WaitForDrainOptions {
  /**
   * Resolve once {@link Peer.bufferedAmount} drops to or below this many bytes.
   *
   * @default 0
   */
  threshold?: number;

  /**
   * Polling interval (in milliseconds) used to re-check {@link Peer.bufferedAmount}.
   *
   * @default 100
   */
  pollInterval?: number;

  /**
   * Abort the wait (e.g. `AbortSignal.timeout(ms)`). The returned promise
   * rejects with the signal's `reason`.
   */
  signal?: AbortSignal;
}

export interface AdapterInternal {
  ws: unknown;
  request: Request;
  namespace: string;
  peers?: Set<Peer>;
  context?: PeerContext;
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

  get context(): PeerContext {
    return (this._internal.context ??= {});
  }

  get namespace(): string {
    return this._internal.namespace;
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

  /**
   * Number of bytes queued for transmission but not yet flushed to the client.
   *
   * Use this to apply backpressure: pause sending while it grows past a high
   * watermark and resume once it drops (or on the `drain` hook). Returns `0` on
   * adapters that do not expose a buffer signal. Refer to the
   * [compatibility table](https://crossws.h3.dev/guide/peer#compatibility).
   */
  get bufferedAmount(): number {
    return (this._internal.ws as Partial<web.WebSocket>)?.bufferedAmount ?? 0;
  }

  /**
   * Wait until the send buffer drains to `threshold` bytes (default `0`).
   *
   * Resolves immediately when there is no backpressure (or on adapters that do
   * not expose {@link Peer.bufferedAmount}). Otherwise it polls every
   * `pollInterval` milliseconds until the buffer drains, also resolving early if
   * the connection is no longer open so a send loop never hangs on a dropped
   * client.
   *
   * ```ts
   * for (const chunk of stream) {
   *   peer.send(chunk);
   *   if (peer.bufferedAmount > 1024 * 1024) {
   *     await peer.waitForDrain({ threshold: 256 * 1024 });
   *   }
   * }
   * ```
   */
  waitForDrain(opts: WaitForDrainOptions = {}): Promise<void> {
    const threshold = opts.threshold ?? 0;
    if (this.bufferedAmount <= threshold) {
      return Promise.resolve();
    }
    const signal = opts.signal;
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }
    return new Promise<void>((resolve, reject) => {
      const check = () => {
        // Resolve once drained, or if the socket left the OPEN (1) state — a
        // closed peer never drains, so this prevents a permanent hang + leak.
        if (this.bufferedAmount <= threshold || (this.websocket.readyState ?? 1) > 1) {
          cleanup();
          resolve();
        }
      };
      const onAbort = () => {
        cleanup();
        reject(signal!.reason);
      };
      const timer = setInterval(check, opts.pollInterval ?? 100);
      // Don't keep the event loop alive just for a pending drain check.
      timer.unref?.();
      const cleanup = () => {
        clearInterval(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
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
  abstract send(data: unknown, options?: { compress?: boolean }): number | void | undefined;

  /** Send message to subscribes of topic */
  abstract publish(topic: string, data: unknown, options?: { compress?: boolean }): void;

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

  [kNodeInspect](): unknown {
    return {
      peer: {
        id: this.id,
        ip: this.remoteAddress,
      },
    };
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
