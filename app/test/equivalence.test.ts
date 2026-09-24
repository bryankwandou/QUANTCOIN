// Proves the browser WOTS / spendDigest / Spend layout is byte-identical to client/qc.ts.
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import * as ref from "../../client/qc.ts";
import * as w from "../src/lib/wots";
import { planSpend, spendIxs, vaultAddress, tokenAccountOf } from "../src/lib/vault";
import { PROGRAM_ID, QC_MINT } from "../src/lib/config";

const bytes = (n: number, f: (i: number) => number) => Uint8Array.from({ length: n }, (_, i) => f(i) & 0xff);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const cases = [
  { master: bytes(32, (i) => i), seed: bytes(16, (i) => 255 - i) },
  { master: bytes(32, (i) => i * 37 + 11), seed: bytes(16, (i) => i * 7) },
  { master: new Uint8Array(32), seed: new Uint8Array(16).fill(0xff) },
];
const pk = (n: number) => Keypair.fromSeed(bytes(32, (i) => i + n)).publicKey;

describe("browser WOTS == client/qc.ts", () => {
  it("publicKeyHash", () => {
    for (const c of cases)
      expect(hex(w.publicKeyHash(c.master, c.seed))).toBe(hex(ref.publicKeyHash(Buffer.from(c.master), Buffer.from(c.seed))));
  });

  it("digits and sign, including edge digests", () => {
    const digests = [new Uint8Array(24), new Uint8Array(24).fill(255), bytes(24, (i) => i * 11 + 3)];
    for (const c of cases) for (const d of digests) {
      expect(w.digits(d)).toEqual(ref.digits(Buffer.from(d)));
      const a = w.sign(c.master, c.seed, d);
      expect(a.length).toBe(624);
      expect(hex(a)).toBe(hex(ref.sign(Buffer.from(c.master), Buffer.from(c.seed), Buffer.from(d))));
      expect(hex(w.recoverPkHash(c.seed, d, a))).toBe(hex(w.publicKeyHash(c.master, c.seed)));
    }
  });

  it("spendDigest", () => {
    const [p, v, m, d, r, t] = [1, 2, 3, 4, 5, 6].map(pk);
    for (const amount of [0n, 1n, 12345678900000n, 2n ** 64n - 1n])
      expect(hex(w.spendDigest(p.toBytes(), v.toBytes(), m.toBytes(), d.toBytes(), r.toBytes(), t.toBytes(), amount)))
        .toBe(hex(ref.spendDigest(p, v, m, d, r, t, amount)));
  });

  it("vault address, token account and full Spend instruction", () => {
    const owner = Keypair.fromSeed(bytes(32, (i) => 100 + i));
    const dest = pk(7), refund = pk(8), rentTo = pk(9), amount = 4_200_000n;
    for (const c of cases) {
      const secret = { master: c.master, seed: c.seed };
      const v: ref.VaultKeys = { name: "equiv-test", owner, master: Buffer.from(c.master), seed: Buffer.from(c.seed), used: true };
      const [pda, bump] = ref.vaultAddress(PROGRAM_ID, v);
      const [pda2, bump2] = vaultAddress(PROGRAM_ID, secret, owner.publicKey);
      expect(pda2.toBase58()).toBe(pda.toBase58());
      expect(bump2).toBe(bump);
      expect(tokenAccountOf(QC_MINT, pda2).toBase58()).toBe(ref.vaultTokenAccount(PROGRAM_ID, QC_MINT, v).toBase58());

      const plan = planSpend(PROGRAM_ID, QC_MINT, secret, owner.publicKey, dest, refund, rentTo, amount);
      // Pre-set `signed` so qc.ts takes its retry path and never writes a key file.
      v.signed = plan.digestHex;
      const want = ref.spendIxs(PROGRAM_ID, QC_MINT, v, dest, refund, rentTo, amount);
      const got = spendIxs(PROGRAM_ID, QC_MINT, secret, owner.publicKey, plan);
      expect(got.length).toBe(want.length);
      for (let i = 0; i < got.length; i++) {
        expect(got[i].programId.toBase58()).toBe(want[i].programId.toBase58());
        expect(hex(got[i].data)).toBe(hex(want[i].data));
        expect(got[i].keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]))
          .toEqual(want[i].keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]));
      }
      expect(got[1].data.length).toBe(650);
    }
  });

  it("refuses duplicate accounts (rentTo == owner would hit program error 6)", () => {
    const owner = pk(20);
    expect(() => planSpend(PROGRAM_ID, QC_MINT, cases[0], owner, pk(7), pk(8), owner, 1n)).toThrow(/distinct/);
  });
});

