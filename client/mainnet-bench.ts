// Latency of real QC spends, as a wallet user sees it: client signing, send→processed,
// send→confirmed (websocket notification, polling as fallback), plus SOL cost per spend.
// Spend 1: FROM (e.g. treasury-9) sends N base units to bench vault 1 and moves the rest
// to TREASURY_NEXT. Spends 2..N: bench vault i sends 1 base unit to the payer, the rest
// to bench vault i+1. The treasury is touched once; every spend passes checkSpend first.
// Env: QC_NET, QC_KEYDIR, RPC_URL, PAYER, PROGRAM_ID, MINT, FROM, TREASURY_NEXT, N (default 5),
//      TAG (bench vault names), CU_PRICE (micro-lamports, default 20000), REPORT,
//      FORK_FUND=1 (Surfpool only: create and fill FROM with fake tokens first).
import { ComputeBudgetProgram, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { writeFileSync } from "node:fs";
import { checkSpend, env, loadVault, newVault, spendIxs, vaultAddress, vaultExists, vaultTokenAccount, type VaultKeys } from "./qc.ts";

const { conn, payer, program } = env();
const mint = new PublicKey(process.env.MINT!);
const N = Number(process.env.N ?? 5), TAG = process.env.TAG ?? "bench";
const CU_PRICE = Number(process.env.CU_PRICE ?? 20000);
const get = (name: string) => (vaultExists(name) ? loadVault(name) : newVault(name));
const ataOf = (owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);

if (process.env.FORK_FUND) {
  const v = get(process.env.FROM!);
  const r = await fetch(conn.rpcEndpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "surfnet_setTokenAccount",
    params: [vaultAddress(program, v)[0].toBase58(), mint.toBase58(), { amount: 1_000_000 }, TOKEN_2022_PROGRAM_ID.toBase58()] }) }).then(x => x.json());
  if (r.error) throw new Error(JSON.stringify(r.error));
}

type Row = { from: string; next: string; amount: string; signMs: number; processedMs: number; confirmedMs: number;
  slotsToLand: number; cu: number; feeLamports: number; costLamports: number; tx: string; via: string };
const rows: Row[] = [];

async function spend(from: VaultKeys, next: VaultKeys, destOwner: PublicKey, amount: bigint) {
  await checkSpend(conn, program, mint, from, destOwner, amount, next, payer.publicKey);
  const dest = ataOf(destOwner), nextTa = vaultTokenAccount(program, mint, next);
  const before = await conn.getBalance(payer.publicKey, "confirmed");
  await sendAndConfirmTransaction(conn, new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, dest, destOwner, mint, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, nextTa, vaultAddress(program, next)[0], mint, TOKEN_2022_PROGRAM_ID),
  ), [payer], { commitment: "confirmed" });
  for (let i = 0; ; i++) {
    const [a, b] = await conn.getMultipleAccountsInfo([dest, nextTa], "processed");
    if (a?.owner.equals(TOKEN_2022_PROGRAM_ID) && b?.owner.equals(TOKEN_2022_PROGRAM_ID)) break;
    if (i === 60) throw new Error("token accounts not visible");
    await new Promise(r => setTimeout(r, 500));
  }
  const t0 = performance.now();
  const ixs = spendIxs(program, mint, from, dest, nextTa, payer.publicKey, amount); // records the digest first
  const signMs = performance.now() - t0;
  ixs[0] = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 });
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight })
    .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CU_PRICE }), ...ixs);
  tx.sign(payer, from.owner);
  const raw = tx.serialize();
  const sig = (await import("bs58")).default.encode(tx.signature!);
  let processed = 0, confirmed = 0, via = "ws";
  const s0 = performance.now();
  const sendSlot = await conn.getSlot("processed");
  const done = new Promise<void>((resolve, reject) => {
    const mark = (c: "processed" | "confirmed", err: unknown, src: string) => {
      if (err) return reject(new Error(JSON.stringify(err)));
      const t = performance.now() - s0;
      if (!processed) processed = t;
      if (c === "confirmed" && !confirmed) { confirmed = t; via = src; resolve(); }
    };
    conn.onSignature(sig, r => mark("processed", r.err, "ws"), "processed");
    conn.onSignature(sig, r => mark("confirmed", r.err, "ws"), "confirmed");
    const poll = setInterval(async () => {
      if (confirmed) return clearInterval(poll);
      const st = (await conn.getSignatureStatuses([sig]).catch(() => null))?.value[0];
      if (st) mark(st.confirmationStatus === "processed" ? "processed" : "confirmed", st.err, "poll");
      if (performance.now() - s0 > 60_000) { clearInterval(poll); reject(new Error("not confirmed in 60 s")); }
    }, 250);
  });
  await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 5 });
  await done;
  const t = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  const after = await conn.getBalance(payer.publicKey, "confirmed");
  const row: Row = { from: from.name, next: next.name, amount: amount.toString(), signMs: +signMs.toFixed(1),
    processedMs: Math.round(processed), confirmedMs: Math.round(confirmed), slotsToLand: (t?.slot ?? 0) - sendSlot,
    cu: t?.meta?.computeUnitsConsumed ?? 0, feeLamports: t?.meta?.fee ?? 0, costLamports: before - after, tx: sig, via };
  rows.push(row);
  console.log(row);
}

const first = get(process.env.FROM!);
const bench = Array.from({ length: N }, (_, i) => get(`${TAG}-${i + 1}`));
await spend(first, get(process.env.TREASURY_NEXT!), vaultAddress(program, bench[0])[0], BigInt(N));
for (let i = 0; i < N - 1; i++) await spend(bench[i], bench[i + 1], payer.publicKey, 1n);

const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
const stat = (k: keyof Row) => { const a = rows.map(r => r[k] as number); return { p50: pct(a, 0.5), max: Math.max(...a), min: Math.min(...a) }; };
const out = { rpc: conn.rpcEndpoint.replace(/api-key=[^&]+/, "api-key=…"), cuPrice: CU_PRICE, n: rows.length,
  signMs: stat("signMs"), processedMs: stat("processedMs"), confirmedMs: stat("confirmedMs"), slotsToLand: stat("slotsToLand"),
  cu: stat("cu"), costLamports: stat("costLamports"), lastVault: bench[N - 1].name, rows };
console.log(JSON.stringify({ ...out, rows: undefined }, null, 1));
writeFileSync(new URL(`../audit/${process.env.REPORT ?? "mainnet-bench"}.json`, import.meta.url), JSON.stringify(out, null, 2));
process.exit(0);
