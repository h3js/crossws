import type { Peer } from "./peer.ts";
import { kNodeInspect } from "./utils.ts";

export class Message implements Partial<MessageEvent> {
  /** Access to the original [message event](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/message_event) if available. */
  readonly event?: MessageEvent;

  /** Access to the Peer that emitted the message. */
  readonly peer?: Peer;

  /** Raw message data (can be of any type). */
  readonly rawData: unknown;

  #id?: string;
  #uint8Array?: Uint8Array;
  #arrayBuffer?: ArrayBuffer | SharedArrayBuffer;
  #blob?: Blob;
  #text?: string;
  #json?: unknown;

  constructor(rawData: unknown, peer: Peer, event?: MessageEvent) {
    this.rawData = rawData || "";
    this.peer = peer;
    this.event = event;
  }

  /**
   * Unique random [uuid v4](https://developer.mozilla.org/en-US/docs/Glossary/UUID) identifier for the message.
   */
  get id(): string {
    if (!this.#id) {
      this.#id = crypto.randomUUID();
    }
    return this.#id;
  }

  // --- data views ---

  /**
   * Get data as [Uint8Array](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Uint8Array) value.
   *
   * If raw data is in any other format or string, it will be automatically converted and encoded.
   */
  uint8Array(): Uint8Array {
    // Cached
    const _uint8Array = this.#uint8Array;
    if (_uint8Array) {
      return _uint8Array;
    }
    const rawData = this.rawData;
    // Uint8Array
    if (rawData instanceof Uint8Array) {
      return (this.#uint8Array = rawData);
    }
    // ArrayBuffer
    if (
      rawData instanceof ArrayBuffer ||
      rawData instanceof SharedArrayBuffer
    ) {
      this.#arrayBuffer = rawData;
      return (this.#uint8Array = new Uint8Array(rawData));
    }
    // String
    if (typeof rawData === "string") {
      this.#text = rawData;
      return (this.#uint8Array = new TextEncoder().encode(this.#text));
    }
    // Iterable and ArrayLike
    if (Symbol.iterator in (rawData as Iterable<number>)) {
      return (this.#uint8Array = new Uint8Array(rawData as Iterable<number>));
    }
    if (typeof (rawData as ArrayLike<number>)?.length === "number") {
      return (this.#uint8Array = new Uint8Array(rawData as ArrayLike<number>));
    }
    // DataView
    if (rawData instanceof DataView) {
      return (this.#uint8Array = new Uint8Array(
        rawData.buffer,
        rawData.byteOffset,
        rawData.byteLength,
      ));
    }
    throw new TypeError(
      `Unsupported message type: ${Object.prototype.toString.call(rawData)}`,
    );
  }

  /**
   * Get data as [ArrayBuffer](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/ArrayBuffer) or [SharedArrayBuffer](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer) value.
   *
   * If raw data is in any other format or string, it will be automatically converted and encoded.
   */
  arrayBuffer(): ArrayBuffer | SharedArrayBuffer {
    // Cached
    const _arrayBuffer = this.#arrayBuffer;
    if (_arrayBuffer) {
      return _arrayBuffer;
    }
    const rawData = this.rawData;
    // Use as-is
    if (
      rawData instanceof ArrayBuffer ||
      rawData instanceof SharedArrayBuffer
    ) {
      return (this.#arrayBuffer = rawData);
    }
    // Fallback to UInt8Array
    return (this.#arrayBuffer = this.uint8Array().buffer);
  }

  /**
   * Get data as [Blob](https://developer.mozilla.org/en-US/docs/Web/API/Blob) value.
   *
   * If raw data is in any other format or string, it will be automatically converted and encoded. */
  blob(): Blob {
    // Cached
    const _blob = this.#blob;
    if (_blob) {
      return _blob;
    }
    const rawData = this.rawData;
    // Use as-is
    if (rawData instanceof Blob) {
      return (this.#blob = rawData);
    }
    // Fallback to UInt8Array
    return (this.#blob = new Blob([this.uint8Array() as Uint8Array<any>]));
  }

  /**
   * Get stringified text version of the message.
   *
   * If raw data is in any other format, it will be automatically converted and decoded.
   */
  text(): string {
    // Cached
    const _text = this.#text;
    if (_text) {
      return _text;
    }
    const rawData = this.rawData;
    // Use as-is
    if (typeof rawData === "string") {
      return (this.#text = rawData);
    }
    // Fallback to UInt8Array
    return (this.#text = new TextDecoder().decode(this.uint8Array()));
  }

  /**
   * Get parsed version of the message text with [`JSON.parse()`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/parse).
   */
  json<T = unknown>(): T {
    const _json = this.#json;
    if (_json) {
      return _json as T;
    }
    return (this.#json = JSON.parse(this.text()));
  }

  /**
   * Message data (value varies based on `peer.websocket.binaryType`).
   */
  get data(): unknown {
    switch (this.peer?.websocket?.binaryType as string) {
      case "arraybuffer": {
        return this.arrayBuffer();
      }
      case "blob": {
        return this.blob();
      }
      case "nodebuffer": {
        return globalThis.Buffer
          ? Buffer.from(this.uint8Array())
          : this.uint8Array();
      }
      case "uint8array": {
        return this.uint8Array();
      }
      case "text": {
        return this.text();
      }
      default: {
        return this.rawData;
      }
    }
  }

  // --- inspect ---

  toString(): string {
    return this.text();
  }

  [Symbol.toPrimitive](): string {
    return this.text();
  }

  [kNodeInspect](): unknown {
    return {
      message: {
        id: this.id,
        peer: this.peer,
        text: this.text(),
      },
    };
  }
}
