import { test, expect } from "vitest";
import { toBufferLike } from "../src/utils";

test("toBufferLike", () => {
  expect(toBufferLike(undefined)).toBe("");
  expect(toBufferLike(null)).toBe("");
  expect(toBufferLike("")).toBe("");
  expect(toBufferLike("hello")).toBe("hello");
  expect(toBufferLike(123)).toBe("123");
  expect(toBufferLike({ a: 1 })).toBe('{"a":1}');
  expect(toBufferLike(Buffer.from("hello"))).toEqual(Buffer.from("hello"));
  expect(toBufferLike(new Uint8Array([1, 2, 3]))).toEqual(
    new Uint8Array([1, 2, 3]),
  );
  expect(toBufferLike(new ArrayBuffer(3))).toEqual(new ArrayBuffer(3));
});
