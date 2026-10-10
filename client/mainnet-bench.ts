// Latency of real QC spends, as a wallet user sees it: client signing, send→processed,
// send→confirmed (websocket notification, polling as fallback), plus SOL cost per spend.
// Phase 1 (sequential): FROM (e.g. treasury-9) funds a chain of bench vaults, each of which
// funds one parallel vault. Phase 2: PARALLEL vaults spend at the same moment. The treasury
// is touched once; every spend passes checkSpend before its one-time key signs.
// Env: QC_NET, QC_KEYDIR, RPC_URL, PAYER, PROGRAM_ID, MINT, FROM, TREASURY_NEXT, PARALLEL (default 10),
//      TAG (bench vault names), CU_PRICE (micro-lamports, default 20000), REPORT,
//      FORK_FUND=1 (Surfpool only: create and fill FROM with fake tokens first).
import { ComputeBudgetProgram, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { writeFileSync } from "node:fs";
import bs58 from "bs58";
import { checkSpend, env, loadVault, newVault, spendIxs, vaultAddress, vaultExists, vaultTokenAccount, type VaultKeys } from "./qc.ts";

const { conn, payer, program } = env();
const mint = new PublicKey(process.env.MINT!);
const P = Number(process.env.PARALLEL ?? 10), TAG = process.env.TAG ?? "bench";
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

type Row = { mode: string; from: string; amount: string; signMs: number; processedMs: number; confirmedMs: number;
  slotsToLand: number; cu: number; feeLamports: number; costLamports: number; tx: string; via: string };
const rows: Row[] = [];

type Prep = { label: string; raw: Buffer; sig: string; signMs: number; amount: bigint };
/** Creates the token accounts the spend needs, then signs it (the one-time digest is recorded first). */
async function prepare(from: VaultKeys, destOwner: PublicKey, amount: bigint, next?: VaultKeys, refundTa?: PublicKey): Promise<Prep> {
  await checkSpend(conn, program, mint, from, destOwner, amount, next, payer.publicKey);
  const dest = ataOf(destOwner), refund = next ? vaultTokenAccount(program, mint, next) : refundTa!;
  const need = [createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, dest, destOwner, mint, TOKEN_2022_PROGRAM_ID)];
  if (next) need.push(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, refund, vaultAddress(program, next)[0], mint, TOKEN_2022_PROGRAM_ID));
  await sendAndConfirmTransaction(conn, new Transaction().add(...need), [payer], { commitment: "confirmed" });
  for (let i = 0; ; i++) {
    const [x, y] = await conn.getMultipleAccountsInfo([dest, refund], "processed");
    if (x?.owner.equals(TOKEN_2022_PROGRAM_ID) && y?.owner.equals(TOKEN_2022_PROGRAM_ID)) break;
    if (i === 60) throw new Error("token accounts not visible");
    await new Promise(r => setTimeout(r, 500));
  }
  const t0 = performance.now();
  const ixs = spendIxs(program, mint, from, dest, refund, payer.publicKey, amount);
  const signMs = performance.now() - t0;
  ixs[0] = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 });
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight })
    .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CU_PRICE }), ...ixs);
  tx.sign(payer, from.owner);
  return { label: from.name, raw: tx.serialize(), sig: bs58.encode(tx.signature!), signMs, amount };
}

/** Sends a signed spend and times processed / confirmed. */
async function land(p: Prep, mode: string, costLamports = 0): Promise<Row> {
  let processed = 0, confirmed = 0, via = "ws";
  const s0 = performance.now();
  const sendSlot = await conn.getSlot("processed");
  const done = new Promise<void>((resolve, reject) => {
    const mark = (c: "processed" | "confirmed", err: unknown, src: string) => {
      if (err) return reject(new Error(p.label + " " + JSON.stringify(err)));
      const t = performance.now() - s0;
      if (!processed) processed = t;
      if (c === "confirmed" && !confirmed) { confirmed = t; via = src; resolve(); }
    };
    conn.onSignature(p.sig, r => mark("processed", r.err, "ws"), "processed");
    conn.onSignature(p.sig, r => mark("confirmed", r.err, "ws"), "confirmed");
    const poll = setInterval(async () => {
      if (confirmed) return clearInterval(poll);
      const st = (await conn.getSignatureStatuses([p.sig]).catch(() => null))?.value[0];
      if (st) mark(st.confirmationStatus === "processed" ? "processed" : "confirmed", st.err, "poll");
      if (performance.now() - s0 > 60_000) { clearInterval(poll); reject(new Error(p.label + " not confirmed in 60 s")); }
    }, 400);
  });
  await conn.sendRawTransaction(p.raw, { skipPreflight: true, maxRetries: 5 });
  await done;
  const t = await conn.getTransaction(p.sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  const row: Row = { mode, from: p.label, amount: p.amount.toString(), signMs: +p.signMs.toFixed(1),
    processedMs: Math.round(processed), confirmedMs: Math.round(confirmed), slotsToLand: (t?.slot ?? 0) - sendSlot,
    cu: t?.meta?.computeUnitsConsumed ?? 0, feeLamports: t?.meta?.fee ?? 0, costLamports, tx: p.sig, via };
  rows.push(row);
  console.log(row);
  return row;
}
async function sequential(from: VaultKeys, destOwner: PublicKey, amount: bigint, next: VaultKeys) {
  const before = await conn.getBalance(payer.publicKey, "confirmed");
  const p = await prepare(from, destOwner, amount, next);
  const r = await land(p, "sequential");
  r.costLamports = before - (await conn.getBalance(payer.publicKey, "confirmed"));
}

// Spend 1: treasury -> chain head (P + 1 units). Chain vault i sends 1 unit to parallel vault i.
// Then all P parallel vaults spend their 1 unit to the payer at the same moment (refund = the
// new treasury token account, which receives nothing since rest = 0).
const first = get(process.env.FROM!), treasuryNext = get(process.env.TREASURY_NEXT!);
const chain = Array.from({ length: P + 1 }, (_, i) => get(`${TAG}-c${i + 1}`));
const par = Array.from({ length: P }, (_, i) => get(`${TAG}-p${i + 1}`));
await sequential(first, vaultAddress(program, chain[0])[0], BigInt(P + 1), treasuryNext);
for (let i = 0; i < P; i++) await sequential(chain[i], vaultAddress(program, par[i])[0], 1n, chain[i + 1]);
const before = await conn.getBalance(payer.publicKey, "confirmed");
const preps = [];
for (const v of par) preps.push(await prepare(v, payer.publicKey, 1n, undefined, vaultTokenAccount(program, mint, treasuryNext)));
const wall0 = performance.now();
await Promise.all(preps.map(p => land(p, "parallel")));
const parallelWallMs = Math.round(performance.now() - wall0);
const parallelCost = before - (await conn.getBalance(payer.publicKey, "confirmed"));

const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
const stat = (mode: string, k: keyof Row) => { const a = rows.filter(r => r.mode === mode).map(r => r[k] as number);
  return { p50: pct(a, 0.5), max: Math.max(...a), min: Math.min(...a) }; };
const sum = (mode: string) => ({ n: rows.filter(r => r.mode === mode).length, signMs: stat(mode, "signMs"),
  processedMs: stat(mode, "processedMs"), confirmedMs: stat(mode, "confirmedMs"), slotsToLand: stat(mode, "slotsToLand"), cu: stat(mode, "cu") });
const out = { rpc: conn.rpcEndpoint.replace(/api-key=[^&]+/, "api-key=…"), cuPrice: CU_PRICE,
  sequential: { ...sum("sequential"), costLamports: stat("sequential", "costLamports") },
  parallel: { ...sum("parallel"), wallMs: parallelWallMs, costLamportsTotal: parallelCost },
  leftover: chain[P].name, rows };
console.log(JSON.stringify({ ...out, rows: undefined }, null, 1));
writeFileSync(new URL(`../audit/${process.env.REPORT ?? "mainnet-bench"}.json`, import.meta.url), JSON.stringify(out, null, 2));
process.exit(0);
