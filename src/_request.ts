export const StubRequest = /* @__PURE__ */ (() => {
  class StubRequest implements Omit<Request, "fetcher" | "cf"> {
    url: string;

    _signal?: AbortSignal;
    _headers?: Headers;
    _init?: RequestInit;

    constructor(url: string, init: RequestInit = {}) {
      this.url = url;
      this._init = init;
    }

    get headers(): Headers {
      if (!this._headers) {
        this._headers = new Headers(this._init?.headers);
      }
      return this._headers;
    }

    clone() {
      return new StubRequest(this.url, this._init) as any;
    }

    // --- dummy ---

    get method() {
      return "GET"; // https://github.com/h3js/crossws/issues/137
    }

    get signal() {
      return (this._signal ??= new AbortSignal());
    }

    get cache() {
      return "default" as const;
    }

    get credentials() {
      return "same-origin" as const;
    }

    get destination() {
      return "" as const;
    }

    get integrity() {
      return "";
    }

    get keepalive() {
      return false;
    }

    get redirect() {
      return "follow" as const;
    }

    get mode() {
      return "cors" as const;
    }

    get referrer() {
      return "about:client";
    }

    get referrerPolicy() {
      return "" as any;
    }

    get body() {
      return null; // eslint-disable-line unicorn/no-null
    }

    get bodyUsed() {
      return false;
    }

    arrayBuffer(): Promise<ArrayBuffer> {
      return Promise.resolve(new ArrayBuffer(0));
    }

    blob() {
      return Promise.resolve(new Blob());
    }

    bytes() {
      return Promise.resolve(new Uint8Array());
    }

    formData() {
      return Promise.resolve(new FormData());
    }

    json() {
      return Promise.resolve(JSON.parse(""));
    }

    text() {
      return Promise.resolve("");
    }
  }

  Object.setPrototypeOf(StubRequest.prototype, globalThis.Request.prototype);

  return StubRequest;
})() as unknown as {
  new (url: string, init?: RequestInit): Request;
};
