// app/src/lib/store.ts reads and writes a synchronous Storage. Extensions persist in
// chrome.storage.local (async), so this keeps an in-memory mirror that is hydrated once
// at startup and written through on every setItem. flush() resolves when every write
// has reached chrome.storage.local; the spend path awaits it before broadcasting.
export interface KV { get(k: string[]): Promise<Record<string, unknown>>; set(o: Record<string, unknown>): Promise<void> }

const mem = new Map<string, string>();
let backend: KV | null = null;
let pending: Promise<void> = Promise.resolve();
let failure: Error | null = null;

export async function hydrate(kv: KV, keys: string[]) {
  backend = kv;
  const got = await kv.get(keys);
  for (const k of keys) if (typeof got[k] === "string") mem.set(k, got[k] as string);
}

export const syncStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => {
    mem.set(k, v);
    if (!backend) return;
    const b = backend;
    pending = pending.then(() => b.set({ [k]: v })).catch((e) => { failure = e as Error; });
  },
};

/** Throws if any write since startup failed: callers must not broadcast on unsaved state. */
export async function flush() {
  await pending;
  if (failure) throw new Error(`could not save to extension storage: ${failure.message}`);
}

export function chromeKV(): KV {
  const s = chrome.storage.local;
  return { get: (k) => s.get(k) as Promise<Record<string, unknown>>, set: (o) => s.set(o) };
}
