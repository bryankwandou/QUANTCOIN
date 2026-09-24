// Browser WOTS: byte-for-byte mirror of client/qc.ts and programs/qc-vault/src/wots.rs.
import { sha256 } from "@noble/hashes/sha2.js";

export const N = 24, MSG_DIGITS = 24, CHAINS = 26, SEED_LEN = 16, MASTER_LEN = 32;
const ascii = (s: string) => new TextEncoder().encode(s);
const D_CHAIN = ascii("QCV1/chain"), D_PK = ascii("QCV1/pk"), D_MSG = ascii("QCV1/msg"), D_SK = ascii("QCV1/sk");

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function sha(...parts: Uint8Array[]): Uint8Array {
  const h = sha256.create();
  for (const p of parts) h.update(p);
  return h.digest();
}

function chain(seed: Uint8Array, i: number, from: number, to: number, x: Uint8Array): Uint8Array {
  let v = x;
  for (let s = from; s < to; s++) v = sha(D_CHAIN, seed, Uint8Array.of(i, s), v).subarray(0, N);
  return v;
}

export function digits(digest: Uint8Array): number[] {
  const d = [...digest.subarray(0, MSG_DIGITS)];
  const csum = d.reduce((a, x) => a + (255 - x), 0);
  return [...d, csum >> 8, csum & 0xff];
}

const secretChain = (master: Uint8Array, i: number) => sha(D_SK, master, Uint8Array.of(i)).subarray(0, N);

export function publicKeyHash(master: Uint8Array, seed: Uint8Array): Uint8Array {
  const ends: Uint8Array[] = [];
  for (let i = 0; i < CHAINS; i++) ends.push(chain(seed, i, 0, 255, secretChain(master, i)));
  return sha(D_PK, seed, concat(...ends));
}

export function sign(master: Uint8Array, seed: Uint8Array, digest: Uint8Array): Uint8Array {
  const d = digits(digest);
  const out: Uint8Array[] = [];
  for (let i = 0; i < CHAINS; i++) out.push(chain(seed, i, 0, d[i], secretChain(master, i)));
  return concat(...out);
}

/** Mirror of wots.rs recover_pk_hash; used to self-check a signature before sending. */
export function recoverPkHash(seed: Uint8Array, digest: Uint8Array, sig: Uint8Array): Uint8Array {
  const d = digits(digest);
  const ends: Uint8Array[] = [];
  for (let i = 0; i < CHAINS; i++) ends.push(chain(seed, i, d[i], 255, sig.subarray(i * N, (i + 1) * N)));
  return sha(D_PK, seed, concat(...ends));
}

export const u64le = (v: bigint) => {
  const a = new Uint8Array(8);
  new DataView(a.buffer).setBigUint64(0, v, true);
  return a;
};

/** All key inputs are 32-byte public keys. */
export function spendDigest(program: Uint8Array, vault: Uint8Array, mint: Uint8Array, dest: Uint8Array,
  refund: Uint8Array, rentTo: Uint8Array, amount: bigint): Uint8Array {
  return sha(D_MSG, program, vault, mint, dest, refund, rentTo, u64le(amount)).subarray(0, MSG_DIGITS);
}

export const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
export const fromHex = (h: string) => {
  if (!/^([0-9a-f]{2})*$/i.test(h)) throw new Error("bad hex");
  return Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
};
export const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
