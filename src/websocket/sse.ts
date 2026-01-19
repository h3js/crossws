import type * as web from "../../types/web";

type Ctor<T> = { prototype: T; new (): T };
const _EventTarget = EventTarget as Ctor<web.EventTarget>;

export interface WebSocketSSEOptions {
  protocols?: string | string[];
  /** enabled by default */
  bidir?: boolean;
  /** enabled by default */
  stream?: boolean;
  headers?: HeadersInit;
}

const defaultOptions: WebSocketSSEOptions = Object.freeze({
  bidir: true,
  stream: true,
});

export class WebSocketSSE extends _EventTarget implements web.WebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  onclose: ((this: web.WebSocket, ev: web.CloseEvent) => any) | null = null;
  onerror: ((this: web.WebSocket, ev: web.Event) => any) | null = null;
  onopen: ((this: web.WebSocket, ev: web.Event) => any) | null = null;
  onmessage: ((this: web.WebSocket, ev: web.MessageEvent<any>) => any) | null =
    null;

  binaryType: BinaryType = "blob";
  readyState: number = WebSocketSSE.CONNECTING;

  readonly url: string;
  readonly protocol: string = "";
  readonly extensions: string = "";
  readonly bufferedAmount: number = 0;

  #options: WebSocketSSEOptions = {};

  #sse: EventSource;

  #id?: string;
  #sendController?: ReadableStreamDefaultController<string>;
  #queue: any[] = [];

  constructor(url: string, init?: string | string[] | WebSocketSSEOptions) {
    super();

    this.url = url.replace(/^ws/, "http");

    if (typeof init === "string") {
      this.#options = { ...defaultOptions, protocols: init };
    } else if (Array.isArray(init)) {
      this.#options = { ...defaultOptions, protocols: init };
    } else {
      this.#options = { ...defaultOptions, ...init };
    }

    this.#sse = new EventSource(this.url);

    this.#sse.addEventListener("open", (_sseEvent) => {
      this.readyState = WebSocketSSE.OPEN;
      const event = new Event("open");
      this.onopen?.(event);
      this.dispatchEvent(event);
    });

    this.#sse.addEventListener("message", (sseEvent) => {
      const _event = new MessageEvent("message", {
        data: sseEvent.data,
      });
      this.onmessage?.(_event);
      this.dispatchEvent(_event);
    });

    if (this.#options.bidir) {
      this.#sse.addEventListener("crossws-id", (sseEvent) => {
        this.#id = sseEvent.data;
        if (this.#options.stream) {
          fetch(this.url, {
            method: "POST",
            // @ts-expect-error
            duplex: "half",
            headers: {
              "content-type": "application/octet-stream",
              "x-crossws-id": this.#id!,
            },
            body: new ReadableStream({
              start: (controller) => {
                this.#sendController = controller;
              },
              cancel: () => {
                this.#sendController = undefined;
              },
            }).pipeThrough(new TextEncoderStream()),
          }).catch(() => {});
        }
        for (const data of this.#queue) {
          this.send(data);
        }
        this.#queue = [];
      });
    }

    this.#sse.addEventListener("error", (_sseEvent) => {
      const event = new Event("error");
      this.onerror?.(event);
      this.dispatchEvent(event);
    });

    this.#sse.addEventListener("close", (_sseEvent) => {
      this.readyState = WebSocketSSE.CLOSED;
      const event = new Event("close") as unknown as web.CloseEvent;
      this.onclose?.(event);
      this.dispatchEvent(event);
    });
  }

  close(_code?: number, _reason?: string): void {
    this.readyState = WebSocketSSE.CLOSING;
    this.#sse.close();
    this.readyState = WebSocketSSE.CLOSED;
  }

  async send(data: any): Promise<void> {
    if (!this.#options.bidir) {
      throw new Error("bdir option is not enabled!");
    }
    if (this.readyState !== WebSocketSSE.OPEN) {
      throw new Error("WebSocket is not open!");
    }
    if (!this.#id) {
      this.#queue.push(data);
      return;
    }
    if (this.#sendController) {
      this.#sendController.enqueue(data);
      return;
    }
    await fetch(this.url, {
      method: "POST",
      headers: {
        "x-crossws-id": this.#id,
      },
      body: data,
    });
  }
}
