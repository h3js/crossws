type BufferLike = string | Buffer | Uint8Array | ArrayBuffer;

// https://nodejs.org/api/util.html#utilinspectcustom
export const kNodeInspect: unique symbol = /*#__PURE__*/ Symbol.for(
  "nodejs.util.inspect.custom",
);

export function toBufferLike(val: any): BufferLike {
  if (val === undefined || val === null) {
    return "";
  }

  const type = typeof val;

  if (type === "string") {
    return val;
  }

  if (type === "number" || type === "boolean" || type === "bigint") {
    return val.toString();
  }

  if (type === "function" || type === "symbol") {
    return "{}";
  }

  if (val instanceof Uint8Array || val instanceof ArrayBuffer) {
    return val;
  }

  if (isPlainObject(val)) {
    return JSON.stringify(val);
  }

  return val;
}

export function toString(val: any): string {
  if (typeof val === "string") {
    return val;
  }
  const data = toBufferLike(val);
  if (typeof data === "string") {
    return data;
  }
  const base64 = btoa(String.fromCharCode(...new Uint8Array(data)));
  return `data:application/octet-stream;base64,${base64}`;
}

// Forked from sindresorhus/is-plain-obj (MIT)
// Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)
// From https://github.com/unjs/defu/blob/main/src/_utils.ts
export function isPlainObject(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);

  if (
    prototype !== null &&
    prototype !== Object.prototype &&
    Object.getPrototypeOf(prototype) !== null
  ) {
    return false;
  }

  if (Symbol.iterator in value) {
    return false;
  }

  if (Symbol.toStringTag in value) {
    return Object.prototype.toString.call(value) === "[object Module]";
  }

  return true;
}
