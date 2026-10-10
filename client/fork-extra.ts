// Surfpool only: adversarial and edge cases for the release candidate, beyond the
// reported findings. Run after fork-install.ts + a real fork extend/deploy.
// Env: SURF_RPC, SURF_PAYER, REPORT.
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction,
  createEnableCpiGuardInstruction, createEnableRequiredMemoTransfersInstruction, createReallocateInstruction, ExtensionType,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { randomInt } from "node:crypto";
import { writeFileSync } from "node:fs";
import { sign, spendDigest } from "./qc.ts";
import { MEMO, makeAlt, sendV0, ata, bal, conn, fund, mint, mkVault, payer, program, refundTa, rpc, send, spendIx, spent, wallet } from "./fork-lib.ts";

const results: { name: string; ok: boolean; detail?: unknown }[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  results.push({ name, ok, detail });
  console.log(ok ? "ok  " : "FAIL", name, ok ? "" : JSON.stringify(detail)?.slice(0, 400));
};
const code = (err: string | null) => err?.match(/custom program error: (0x[0-9a-f]+)/)?.[1] ?? (err ? "other" : null);
const MARKER = await conn.getMinimumBalanceForRentExemption(0);
// Shared lookup table: fixed accounts a memo spend reads but never invokes at top level.
const alt = await makeAlt([mint, TOKEN_2022_PROGRAM_ID, SystemProgram.programId, MEMO]);

// A. Recipient turns on "require memos" AFTER the spend was signed: the same signature lands with the memo.
{
  const v = mkVault(); await fund(v, 1000n);
  const d = await wallet(false), refund = await refundTa(false);
  const ixs = spendIx(v, d.ta, refund, 100n, MEMO); // signed now
  await send([createReallocateInstruction(d.ta, payer.publicKey, [ExtensionType.MemoTransfer], d.w.publicKey, [], TOKEN_2022_PROGRAM_ID),
    createEnableRequiredMemoTransfersInstruction(d.ta, d.w.publicKey, [], TOKEN_2022_PROGRAM_ID)], [d.w]);
  const r = await send(ixs, [v.owner]);
  check("A memo turned on after signing → still lands", !r.err && (await bal(d.ta)) === 100n, r.err);
}
// B. Recipient closes its token account after signing: spend fails, vault intact; recreate the ATA → same signature lands.
{
  const v = mkVault(); await fund(v, 1000n);
  const d = await wallet(false), refund = await refundTa(false);
  const ixs = spendIx(v, d.ta, refund, 100n, MEMO);
  await send([createCloseAccountInstruction(d.ta, payer.publicKey, d.w.publicKey, [], TOKEN_2022_PROGRAM_ID)], [d.w]);
  const r1 = await send(ixs, [v.owner]);
  check("B closed payee → fails, vault intact", !!r1.err && !(await spent(v)) && (await bal(v.ta)) === 1000n, r1.err);
  await send([createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, d.ta, d.w.publicKey, mint, TOKEN_2022_PROGRAM_ID)]);
  const r2 = await send(ixs, [v.owner]);
  check("B recreated ATA → same signature lands", !r2.err && (await bal(d.ta)) === 100n, r2.err);
}
// C. Someone deposits into the vault between signing and landing: the extra goes to refund, nothing stuck.
{
  const v = mkVault(); await fund(v, 1000n);
  const d = await wallet(false), refund = await refundTa(false);
  const ixs = spendIx(v, d.ta, refund, 100n, MEMO);
  await fund(v, 5000n);
  const r = await send(ixs, [v.owner]);
  check("C late deposit → refund gets the rest", !r.err && (await bal(d.ta)) === 100n && (await bal(refund)) === 4900n, r.err);
}
// D. Payee with CPI Guard on: receiving is unaffected.
{
  const v = mkVault(); await fund(v, 1000n);
  const d = await wallet(false), refund = await refundTa(false);
  const g = await send([createReallocateInstruction(d.ta, payer.publicKey, [ExtensionType.CpiGuard], d.w.publicKey, [], TOKEN_2022_PROGRAM_ID),
    createEnableCpiGuardInstruction(d.ta, d.w.publicKey, [], TOKEN_2022_PROGRAM_ID)], [d.w]);
  const r = await send(spendIx(v, d.ta, refund, 100n, MEMO), [v.owner]);
  check("D CPI-guarded payee → lands", !g.err && !r.err && (await bal(d.ta)) === 100n, g.err ?? r.err);
}
// E. Wrong-mint / legacy-token payee: rejected, vault intact.
{
  const v = mkVault(); await fund(v, 1000n);
  const refund = await refundTa(false);
  const usdc = getAssociatedTokenAddressSync(new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), payer.publicKey, false, TOKEN_PROGRAM_ID);
  await send([createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, usdc, payer.publicKey,
    new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), TOKEN_PROGRAM_ID)]);
  const r = await send(spendIx(v, usdc, refund, 100n, MEMO), [v.owner]);
  check("E legacy-token payee → fails, vault intact", !!r.err && !(await spent(v)), r.err);
}
// F. Over-spend and u64::MAX: InsufficientBalance (0x3).
for (const amt of [1001n, 2n ** 64n - 1n]) {
  const v = mkVault(); await fund(v, 1000n);
  const d = await wallet(false), refund = await refundTa(false);
  const r = await send(spendIx(v, d.ta, refund, amt, MEMO), [v.owner]);
  check(`F amount ${amt} → InsufficientBalance`, code(r.err) === "0x3" && !(await spent(v)), r.err);
}
// G. amount = 0: only the refund transfer (program allows it; clients refuse it).
{
  const v = mkVault(); await fund(v, 1000n);
  const d = await wallet(true), refund = await refundTa(true);
  const r = await send(spendIx(v, d.ta, refund, 0n, MEMO), [v.owner]);
  check("G amount 0, memo-required refund → refund gets all", !r.err && (await bal(refund)) === 1000n && (await bal(d.ta)) === 0n, r.err);
}
// H. Owner not signing: MissingOwnerSignature (0x7).
{
  const v = mkVault(); await fund(v, 1000n);
  const d = await wallet(false), refund = await refundTa(false);
  const r = await send(spendIx(v, d.ta, refund, 100n, MEMO, { ownerSigns: false }));
  check("H no owner signature → 0x7", code(r.err) === "0x7" && !(await spent(v)), r.err);
}
// I. Relayer swaps rent_to / payee / refund after signing: BadSignature (0x2).
{
  const v = mkVault(); await fund(v, 1000n);
  const d = await wallet(false), refund = await refundTa(false), evil = await wallet(false);
  const sig = sign(v.master, v.seed, spendDigest(program, v.pda, mint, d.ta, refund, payer.publicKey, 100n));
  for (const [label, ixs] of [
    ["payee", spendIx(v, evil.ta, refund, 100n, MEMO, { sig })],
    ["refund", spendIx(v, d.ta, evil.ta, 100n, MEMO, { sig })],
    ["amount", spendIx(v, d.ta, refund, 999n, MEMO, { sig })],
  ] as const) {
    const r = await send(ixs, [v.owner]);
    check(`I swapped ${label} → BadSignature`, code(r.err) === "0x2" && !(await spent(v)), r.err);
  }
  // rent_to differs from the fee payer, so it needs a v0 transaction (see M).
  const r = await sendV0(spendIx(v, d.ta, refund, 100n, MEMO, { sig, rentTo: evil.w.publicKey }), [v.owner], alt);
  check("I swapped rent_to → BadSignature", code(r.err) === "0x2" || /"Custom":2}/.test(r.err ?? ""), r.err);
  check("I vault intact after swaps", !(await spent(v)));
}
// J. 200 random single-byte flips of a memo spend's signature/seed: every one rejected, vault intact.
{
  const v = mkVault(); await fund(v, 1000n);
  const d = await wallet(true), refund = await refundTa(false);
  let bad = 0;
  for (let i = 0; i < 200; i++) {
    const ixs = spendIx(v, d.ta, refund, 100n, MEMO);
    const data = ixs[1].data; const at = 2 + randomInt(data.length - 2);
    if (at >= 18 && at < 26) continue; // amount bytes: covered by I
    data[at] ^= 1 + randomInt(255);
    const r = await send(ixs, [v.owner]);
    if (!r.err) bad++;
  }
  check("J 200 byte flips → all rejected", bad === 0 && !(await spent(v)) && (await bal(v.ta)) === 1000n, { bad });
}
// K. Fresh rent_to at mainnet rent: the surplus leaves rent_to rent-exempt, marker keeps exactly its minimum.
{
  const v = mkVault(); await fund(v, 1000n);
  await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: v.pda, lamports: 3_000_000 })]);
  const d = await wallet(true), refund = await refundTa(false), fresh = Keypair.generate().publicKey;
  const r = await sendV0(spendIx(v, d.ta, refund, 100n, MEMO, { rentTo: fresh }), [v.owner], alt);
  const marker = await conn.getBalance(v.pda), got = await conn.getBalance(fresh);
  check("K fresh rent_to + pre-funded vault → marker = rent min", !r.err && marker === MARKER && got >= MARKER, { err: r.err, marker, MARKER, got });
}
// M. rent_to ≠ fee payer with the memo account: a legacy transaction is too large (1,254 > 1,232 B);
//    the same signed spend fits as a v0 transaction with a lookup table and lands.
{
  const v = mkVault(); await fund(v, 1000n);
  const d = await wallet(true), refund = await refundTa(false), other = Keypair.generate().publicKey;
  await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: other, lamports: LAMPORTS_PER_SOL / 100 })]);
  const ixs = spendIx(v, d.ta, refund, 100n, MEMO, { rentTo: other });
  const legacy = await send(ixs, [v.owner]);
  check("M legacy tx too large (expected limit)", /too large/i.test(legacy.err ?? ""), legacy.err);
  const r = await sendV0(ixs, [v.owner], alt);
  check("M same spend as v0 + lookup table → lands", !r.err && (await bal(d.ta)) === 100n && await spent(v), { err: r.err, size: r.size });
  console.log("v0 size:", r.size);
}
// L. 30 random memo spends (random amount split, random memo flags): balances conserve exactly.
{
  let fails = 0;
  for (let i = 0; i < 30; i++) {
    const total = BigInt(1 + randomInt(1_000_000_000)), amt = BigInt(randomInt(Number(total) + 1));
    const v = mkVault(); await fund(v, total);
    const d = await wallet(randomInt(2) === 1), refund = await refundTa(randomInt(2) === 1);
    const r = await send(spendIx(v, d.ta, refund, amt, MEMO), [v.owner]);
    if (r.err || (await bal(d.ta)) !== amt || (await bal(refund)) !== total - amt || !(await spent(v))) {
      fails++; console.log("L case", { total, amt, err: r.err?.slice(0, 200) });
    }
  }
  check("L 30 random memo spends conserve balances", fails === 0, { fails });
}

const failed = results.filter(r => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
writeFileSync(new URL(`../audit/${process.env.REPORT ?? "surfpool-fork-extra"}.json`, import.meta.url),
  JSON.stringify(results, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2));
process.exit(failed ? 1 : 0);
