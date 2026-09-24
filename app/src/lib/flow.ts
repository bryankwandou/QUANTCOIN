// Withdraw orchestration shared by the UI and the node round-trip script.
import { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { VaultRecord, createVault, getVault, openVault, putVault, recordSigned } from "./store";
import { createAtaIx, planSpend, rentCollector, spendIxs, sweepIx, tokenAccountOf } from "./vault";

export interface FlowCtx {
  conn: Connection; program: PublicKey; mint: PublicKey;
  owner: PublicKey;                       // wallet: vault owner and fee payer
  send: (ixs: TransactionInstruction[], label: string) => Promise<string>;  // signed by owner
  sendAs: (ixs: TransactionInstruction[], signer: Keypair, label: string) => Promise<string>; // signed/paid by signer
  /** Must deliver the encrypted backup of a freshly created vault (e.g. force a download). */
  backup: (r: VaultRecord) => Promise<void>;
  log: (m: string) => void;
}

export async function balanceOf(conn: Connection, ata: PublicKey): Promise<bigint | null> {
  const info = await conn.getAccountInfo(ata, "confirmed");
  if (!info) return null;
  return BigInt((await conn.getTokenAccountBalance(ata, "confirmed")).value.amount);
}

export function markSpent(id: string) {
  const r = getVault(id);
  if (r) putVault({ ...r, status: "spent" });
}

/** Spend `amount` to the wallet's token account; the rest goes to a NEW vault.
 *  If this vault already signed a spend, only that identical spend is retried. */
export async function withdraw(ctx: FlowCtx, rec: VaultRecord, amount: bigint, password: string) {
  if (rec.status === "spent") throw new Error("vault already spent");
  const { secret, payload } = await openVault(rec, password);
  const collector = rentCollector(secret);
  const dest = tokenAccountOf(ctx.mint, ctx.owner);

  let pending = rec.pending;
  let next: VaultRecord | undefined;
  if (pending) {
    if (BigInt(pending.amount) !== amount)
      throw new Error(`this vault already signed a spend of ${pending.amount} base units; only that exact spend can be retried`);
    next = getVault(pending.nextId);
    if (!next) throw new Error("the next vault of the signed spend is missing; import its backup first");
  } else {
    if (rec.signed || payload.used) throw new Error("vault key already used but spend parameters are missing");
    ctx.log("Creating the next vault (receives the remainder)...");
    next = (await createVault(ctx.program, ctx.mint, ctx.owner, password)).record;
    await ctx.backup(next);
    next = { ...getVault(next.id)!, backedUp: true };
    putVault(next);
  }
  if (!next.backedUp) throw new Error("back up the next vault before spending");

  const plan = planSpend(ctx.program, ctx.mint, secret, ctx.owner, dest, new PublicKey(next.ata), collector.publicKey, amount);
  if (pending && pending.digest !== plan.digestHex) throw new Error("retry would sign a different digest; refusing");
  pending = { amount: amount.toString(), dest: dest.toBase58(), refund: next.ata, rentTo: collector.publicKey.toBase58(),
    nextId: next.id, digest: plan.digestHex };
  rec = await recordSigned(rec, payload, password, pending);   // persisted BEFORE anything is broadcast
  ctx.log(`Signed digest ${plan.digestHex} saved.`);

  const bal = await balanceOf(ctx.conn, plan.vaultTa);
  if (bal === null) {
    ctx.log("Vault token account is already closed: spend already landed.");
  } else {
    if (bal < amount) throw new Error(`vault balance ${bal} < amount ${amount}`);
    ctx.log("Preparing destination and next-vault token accounts...");
    await ctx.send([
      createAtaIx(ctx.owner, dest, ctx.owner, ctx.mint),
      createAtaIx(ctx.owner, new PublicKey(next.ata), new PublicKey(next.id), ctx.mint),
    ], "prepare accounts");
    ctx.log("Sending spend (WOTS + wallet signature)...");
    try {
      const sig = await ctx.send(spendIxs(ctx.program, ctx.mint, secret, ctx.owner, plan), "spend");
      ctx.log(`Spend confirmed: ${sig}`);
    } catch (e) {
      if ((await balanceOf(ctx.conn, plan.vaultTa)) !== null) throw e;   // not landed; retry allowed (same digest)
      ctx.log("Spend error reported, but the vault is closed: it landed.");
    }
  }
  markSpent(rec.id);
  await sweepRent(ctx, collector);
  return { next, digest: plan.digestHex };
}

export async function sweepRent(ctx: FlowCtx, collector: Keypair) {
  const lamports = await ctx.conn.getBalance(collector.publicKey, "confirmed");
  const ix = sweepIx(collector.publicKey, ctx.owner, lamports);
  if (!ix) return;
  try {
    const sig = await ctx.sendAs([ix], collector, "sweep rent");
    ctx.log(`Returned ${lamports - 5000} lamports of closed-account rent to the wallet: ${sig}`);
  } catch (e) {
    ctx.log(`Rent sweep failed (retry later from the vault list): ${(e as Error).message}`);
  }
}
