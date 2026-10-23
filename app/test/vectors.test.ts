// The browser code must reproduce audit/test-vectors.txt (client/vectors.ts) byte for
// byte; programs/qc-vault/tests/vectors.rs checks the on-chain code against the same file.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import * as w from "../src/lib/wots";
import { parseAmount, tokenAccountOf, vaultAddress } from "../src/lib/vault";
import { PROGRAM_ID, QC_MINT } from "../src/lib/config";

const lines = readFileSync(new URL("../../audit/test-vectors.txt", import.meta.url), "utf8")
  .split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(" "));
const of = (k: string) => lines.filter((f) => f[0] === k);
const h = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("browser code == audit/test-vectors.txt", () => {
  it("vector file is complete", () => {
    expect([of("pk"), of("sig"), of("digest"), of("pda"), of("ata")].map((x) => x.length)).toEqual([3, 9, 4, 3, 3]);
  });

  it("WOTS public key, checksum digits, signatures and self-check", () => {
    for (const f of of("pk")) expect(hex(w.publicKeyHash(h(f[1]), h(f[2])))).toBe(f[3]);
    for (const f of of("sig")) {
      const d = w.digits(h(f[3]));
      expect([d[24], d[25]]).toEqual([Number(f[4]), Number(f[5])]);
      expect(hex(w.sign(h(f[1]), h(f[2]), h(f[3])))).toBe(f[6]);
      expect(hex(w.recoverPkHash(h(f[2]), h(f[3]), h(f[6])))).toBe(hex(w.publicKeyHash(h(f[1]), h(f[2]))));
    }
  });

  it("spend digest, including amount 2^64-1", () => {
    for (const f of of("digest")) {
      expect(f[1]).toBe(hex(PROGRAM_ID.toBytes()));
      expect(hex(w.spendDigest(h(f[1]), h(f[2]), h(f[3]), h(f[4]), h(f[5]), h(f[6]), BigInt(f[7])))).toBe(f[8]);
    }
  });

  it("vault PDA, bump and vault token account", () => {
    for (const f of of("pda")) {
      const [pda, bump] = vaultAddress(PROGRAM_ID, { master: h(f[1]), seed: h(f[2]) }, new PublicKey(h(f[4])));
      expect([hex(pda.toBytes()), bump]).toEqual([f[5], Number(f[6])]);
    }
    for (const f of of("ata")) {
      expect(f[2]).toBe(hex(QC_MINT.toBytes()));
      expect(hex(tokenAccountOf(QC_MINT, new PublicKey(h(f[1]))).toBytes())).toBe(f[3]);
    }
  });

  it("amounts outside u64 are refused, never wrapped", () => {
    expect(hex(w.u64le(w.U64_MAX))).toBe("ff".repeat(8));
    expect(() => w.u64le(w.U64_MAX + 1n)).toThrow(/u64/);
    expect(() => w.u64le(-1n)).toThrow(/u64/);
    expect(() => parseAmount("184467440737095.51616", 5)).toThrow(/too large/);   // 2^64 base units
    expect(parseAmount("184467440737095.51615", 5)).toBe(w.U64_MAX);
  });
});
