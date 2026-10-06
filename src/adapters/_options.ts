// Runtime adapter options shared with `WSOptions` (exported from the root entry).
//
// These types must not import runtime-specific type packages (`bun`,
// `@cloudflare/workers-types`, `cloudflare:workers`, ...) since they are not
// available to consumers and would leak their globals into any program
// reaching the root `crossws` types. See https://github.com/h3js/crossws/issues/209

import type { AdapterOptions } from "../adapter.ts";

// --- bun ---

export interface BunOptions extends AdapterOptions {}

// --- deno ---

export interface DenoOptions extends AdapterOptions {}

// --- cloudflare ---

/**
 * Cloudflare Workers execution context (`ExecutionContext`).
 */
export interface CloudflareExecutionContext {
  waitUntil(promise: Promise<any>): void;
  passThroughOnException(): void;
  props?: any;
}

/**
 * Durable Object stub (`DurableObjectStub`) handling the WebSocket upgrade.
 */
export interface CloudflareDurableStub {
  fetch(input: any, init?: any): Promise<any>;
  webSocketPublish?: (topic: string, data: unknown, opts: any) => Promise<void>;
}

export interface CloudflareOptions extends AdapterOptions {
  /**
   * Durable Object binding name from environment.
   *
   * **Note:** This option will be ignored if `resolveDurableStub` is provided.
   *
   * @default "$DurableObject"
   */
  bindingName?: string;

  /**
   * Durable Object instance name.
   *
   * **Note:** This option will be ignored if `resolveDurableStub` is provided.
   *
   * @default "crossws"
   */
  instanceName?: string;

  /**
   * Custom function that resolves Durable Object binding to handle the WebSocket upgrade.
   *
   * **Note:** This option will override `bindingName` and `instanceName`.
   */
  resolveDurableStub?(
    req: Request | undefined,
    env: unknown,
    context: CloudflareExecutionContext | undefined,
  ): CloudflareDurableStub | undefined | Promise<CloudflareDurableStub | undefined>;
}
