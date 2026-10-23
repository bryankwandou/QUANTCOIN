// A withdrawal the chain would refuse must be refused BEFORE the digest is recorded.
// Once recorded, only that exact spend can be retried, so an impossible amount
// (more than the vault holds, zero, or a vault never funded) left the vault stuck.
import { describe, expect, it } from "vitest";
import { Connection, Keypair } from "@solana/web3.js";
import { createVault, getVault, putVault, useStorage } from "../src/lib/store";
import { FlowCtx, withdraw } from "../src/lib/flow";
import { PROGRAM_ID, QC_MINT } from "../src/lib/config";

const mem = new Map<string, string>();
useStorage({ getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) });
const PW = "correct horse battery";

function ctxWith(held: bigint | null): FlowCtx {
  const conn = {
    getAccountInfo: async () => (held === null ? null : { lamports: 1, data: Buffer.alloc(165) }),
    getTokenAccountBalance: async () => ({ value: { amount: String(held) } }),
  } as unknown as Connection;
  const never = async () => { throw new Error("nothing may be sent"); };
  return { conn, program: PROGRAM_ID, mint: QC_MINT, owner: Keypair.generate().publicKey,
    send: never, sendAs: never, backup: never, log: () => {} };
}

async function fundedVault(ctx: FlowCtx) {
  const { record } = await createVault(PROGRAM_ID, QC_MINT, ctx.owner, PW);
  putVault({ ...record, backedUp: true });
  return getVault(record.id)!;
}

describe("withdraw refuses before recording the digest", () => {
  for (const [name, held, amount, msg] of [
    ["more than the vault holds", 500n, 501n, /holds 500/],
    ["zero", 500n, 0n, /above zero/],
    ["a vault with no token account", null, 1n, /deposit first/],
  ] as const) {
    it(name, async () => {
      const ctx = ctxWith(held);
      const rec = await fundedVault(ctx);
      await expect(withdraw(ctx, rec, amount, PW)).rejects.toThrow(msg);
      const after = getVault(rec.id)!;
      expect(after.signed).toBeUndefined();
      expect(after.pending).toBeUndefined();
      expect(after.status).toBe("active");
    }, 60_000);
  }
});
