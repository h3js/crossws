import type { SyncMessage } from "./types.ts";

// --- wire encoding (used by networked text-transport drivers) ---

export function encodeEnvelope(id: string, msg: SyncMessage): string {
  const binary = msg.data instanceof Uint8Array;
  return JSON.stringify({
    id,
    msg: {
      namespace: msg.namespace,
      topic: msg.topic,
      binary,
      data: binary ? toBase64(msg.data as Uint8Array) : msg.data,
    },
  });
}

export function decodeEnvelope(raw: string): { id: string; msg: SyncMessage } | undefined {
  try {
    const parsed = JSON.parse(raw) as {
      id: string;
      msg: { namespace: string; topic: string; binary?: boolean; data: string };
    };
    return {
      id: parsed.id,
      msg: {
        namespace: parsed.msg.namespace,
        topic: parsed.msg.topic,
        data: parsed.msg.binary ? fromBase64(parsed.msg.data) : parsed.msg.data,
      },
    };
  } catch {
    return undefined;
  }
}

function toBase64(data: Uint8Array): string {
  let binary = "";
  for (const byte of data) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(data: string): Uint8Array {
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
