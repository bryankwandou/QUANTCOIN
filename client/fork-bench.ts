// Surfpool only: latency of one QC spend, split into client signing, send→processed,
// send→confirmed. Fork timing is local (no network, no other validators), so it is a
// floor, not a mainnet number. Env: SURF_RPC, SURF_PAYER, N (default 30).
import { Transaction } from "@solana/web3.js";
import { writeFileSync } from "node:fs";
import { sign, spendDigest } from "./qc.ts";
import { MEMO, conn, fund, mkVault, payer, program, mint, refundTa, spendIx, wallet } from "./fork-lib.ts";

const N = Number(process.env.N ?? 30);
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
const signMs: number[] = [], procMs: number[] = [], confMs: number[] = [], cus: number[] = [];
for (let i = 0; i < N; i++) {
  const v = mkVault(); await fund(v, 1000n);
  const d = await wallet(i % 2 === 0), refund = await refundTa(false);
  const t0 = performance.now();
  const sig = sign(v.master, v.seed, spendDigest(program, v.pda, mint, d.ta, refund, payer.publicKey, 100n));
  const t1 = performance.now();
  const { blockhash } = await conn.getLatestBlockhash("processed");
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash }).add(...spendIx(v, d.ta, refund, 100n, MEMO, { sig }));
  tx.sign(payer, v.owner);
  const raw = tx.serialize();
  const s0 = performance.now();
  const txid = await conn.sendRawTransaction(raw, { skipPreflight: true });
  let proc = 0, conf = 0;
  while (!conf) {
    const st = (await conn.getSignatureStatuses([txid])).value[0];
    if (st?.err) throw new Error(JSON.stringify(st.err));
    const now = performance.now() - s0;
    if (st && !proc) proc = now;
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) conf = now;
    if (now > 30000) throw new Error("timeout");
    if (!conf) await new Promise(r => setTimeout(r, 10));
  }
  const t = await conn.getTransaction(txid, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  signMs.push(t1 - t0); procMs.push(proc); confMs.push(conf); cus.push(t?.meta?.computeUnitsConsumed ?? 0);
  console.log(i, { sign: (t1 - t0).toFixed(1), processed: proc.toFixed(0), confirmed: conf.toFixed(0), cu: cus.at(-1), bytes: raw.length });
}
const sum = (a: number[]) => ({ p50: +pct(a, 0.5).toFixed(1), p90: +pct(a, 0.9).toFixed(1), max: +Math.max(...a).toFixed(1) });
const out = { n: N, signMs: sum(signMs), sendToProcessedMs: sum(procMs), sendToConfirmedMs: sum(confMs), cu: sum(cus) };
console.log(out);
writeFileSync(new URL(`../audit/${process.env.REPORT ?? "surfpool-fork-bench"}.json`, import.meta.url), JSON.stringify(out, null, 2));
