// Surfpool only: finding R-A on a mainnet fork, against whatever binary the fork
// runs (install the release candidate first with fork-install.ts). Real QC mint,
// real Token-2022 and SPL Memo; ephemeral vaults; no real SOL.
// Env: SURF_RPC, SURF_PAYER (a fork-airdropped keypair), EXPECT=new|old.
import { SystemProgram, Keypair } from "@solana/web3.js";
import { writeFileSync } from "node:fs";
import { requiresMemo } from "./qc.ts";
import { MEMO, MEMO_V1, bal, conn, fund, mkVault, refundTa, send, spendIx, spent, wallet, type V } from "./fork-lib.ts";

const expectNew = (process.env.EXPECT ?? "new") === "new";

const results: { name: string; ok: boolean; detail?: unknown }[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  results.push({ name, ok, detail });
  console.log(ok ? "ok  " : "FAIL", name, ok ? "" : JSON.stringify(detail));
};

// 1. Memo-required payee, nine accounts: Token-2022 NoMemo (0x24 = 36), vault untouched.
{
  const v = mkVault(); await fund(v, 1000n);
  const d = await wallet(true), refund = await refundTa(false);
  check("client sees memo flag", requiresMemo((await conn.getAccountInfo(d.ta))!.data));
  const r = await send(spendIx(v, d.ta, refund, 400n), [v.owner]);
  check("9 accounts → NoMemo", !!r.err && /0x24|Custom":36/.test(r.err), r.err?.slice(0, 300));
  check("vault still unspent after NoMemo", !(await spent(v)) && (await bal(v.ta)) === 1000n);
  // 2. Same signed message, now with the memo program: lands.
  const r2 = await send(spendIx(v, d.ta, refund, 400n, MEMO), [v.owner]);
  if (expectNew) {
    check("same message + memo → lands", !r2.err, r2.err?.slice(0, 300));
    check("payee got 400", (await bal(d.ta)) === 400n);
    check("refund got 600", (await bal(refund)) === 600n);
    check("vault marked spent", await spent(v));
    check("memo logged twice", r2.logs.filter(l => l.includes(`Program ${MEMO.toBase58()} invoke`)).length === 2, r2.logs);
    console.log("CU with memo:", r2.cu);
  } else {
    check("old binary rejects 10 accounts", !!r2.err, r2.err?.slice(0, 200));
  }
}
if (expectNew) {
  // 3. Payee and refund both memo-required.
  {
    const v = mkVault(); await fund(v, 1000n);
    const d = await wallet(true), refund = await refundTa(true);
    const r = await send(spendIx(v, d.ta, refund, 300n, MEMO), [v.owner]);
    check("both memo-required → lands", !r.err && (await bal(d.ta)) === 300n && (await bal(refund)) === 700n, r.err?.slice(0, 300));
  }
  // 4. Full drain (rest = 0): one transfer, one memo.
  {
    const v = mkVault(); await fund(v, 500n);
    const d = await wallet(true), refund = await refundTa(false);
    const r = await send(spendIx(v, d.ta, refund, 500n, MEMO), [v.owner]);
    check("full drain + memo → lands", !r.err && (await bal(d.ta)) === 500n && await spent(v), r.err?.slice(0, 300));
  }
  // 5. Wrong 10th account: BadInstruction (0x1), or DuplicateAccount (0x6) for the system program,
  //    which is already account 8. Either way nothing changes.
  for (const [label, k] of [["memo v1", MEMO_V1], ["system", SystemProgram.programId], ["random", Keypair.generate().publicKey]] as const) {
    const v = mkVault(); await fund(v, 1000n);
    const d = await wallet(false), refund = await refundTa(false);
    const r = await send(spendIx(v, d.ta, refund, 100n, k), [v.owner]);
    check(`10th = ${label} → rejected`, !!r.err && /0x[16]\b|Custom":[16]}/.test(r.err) && !(await spent(v)), r.err?.slice(0, 200));
  }
  // 6. Old nine-account clients, ordinary payee: still lands.
  {
    const v = mkVault(); await fund(v, 1000n);
    const d = await wallet(false), refund = await refundTa(false);
    const r = await send(spendIx(v, d.ta, refund, 250n), [v.owner]);
    check("9 accounts, normal payee → lands", !r.err && (await bal(d.ta)) === 250n && (await bal(refund)) === 750n, r.err?.slice(0, 300));
  }
  // 7. Memo account present, ordinary payee: lands (memo harmless).
  {
    const v = mkVault(); await fund(v, 1000n);
    const d = await wallet(false), refund = await refundTa(false);
    const r = await send(spendIx(v, d.ta, refund, 250n, MEMO), [v.owner]);
    check("memo + normal payee → lands", !r.err && (await bal(d.ta)) === 250n, r.err?.slice(0, 300));
  }
  // 8. Replay after success: AlreadySpent (0x8).
  {
    const v = mkVault(); await fund(v, 1000n);
    const d = await wallet(true), refund = await refundTa(false);
    await send(spendIx(v, d.ta, refund, 100n, MEMO), [v.owner]);
    const r = await send(spendIx(v, d.ta, refund, 100n, MEMO), [v.owner]);
    check("replay → AlreadySpent", !!r.err && /0x8\b|Custom":8}/.test(r.err), r.err?.slice(0, 200));
  }
}

const failed = results.filter(r => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
writeFileSync(new URL(`../audit/${process.env.REPORT ?? "surfpool-fork-memo"}.json`, import.meta.url), JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
