// Thousands of tests against a Surfpool fork of MAINNET: the real deployed
// program, the real QC mint and the real Token-2022, with no SOL at stake.
// Vaults here are ephemeral (keys never touch disk) and funded with Surfpool's
// token cheatcode. Real mainnet vaults are only probed with public data.
// Run: surfpool start --network mainnet --no-deploy, then
//      SURF_RPC=http://127.0.0.1:8899 SURF_PAYER=<airdropped keypair> npx tsx surfpool-suite.ts
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createInitializeAccount3Instruction, createTransferCheckedInstruction,
  getAssociatedTokenAddressSync, unpackAccount,
} from "@solana/spl-token";
import { randomBytes, randomInt } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { SEED_LEN, digits, publicKeyHash, sign, spendDigest } from "./qc.ts";

const RPC = process.env.SURF_RPC ?? "http://127.0.0.1:8899";
const conn = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.SURF_PAYER!, "utf8"))));
const program = new PublicKey("CiupyGrAtWomKW5rDWbaMEsm3Db8pY8NPECgL2FfACms");
const mint = new PublicKey("AsEEaydVYMpghdNTrQoVZTAhJSewZT5xD9WE9hpA68W2");
const DECIMALS = 5, MARKER_RENT = await conn.getMinimumBalanceForRentExemption(0), CU_CAP = 1_400_000;
const SCALE = Number(process.env.SCALE ?? 1); // 1 = default sizes below

// ---------- bookkeeping ----------
type Result = { group: string; name: string; ok: boolean; detail?: unknown };
const results: Result[] = [];
const cu: number[] = [];
const errCodes: Record<string, number> = {};
function record(group: string, name: string, ok: boolean, detail?: unknown) {
  results.push({ group, name, ok, detail });
  if (!ok) console.log("FAIL", group, name, JSON.stringify(detail));
  if (results.length % 100 === 0) console.log(`[${new Date().toISOString().slice(11, 19)}] ${results.length} tests, ${results.filter((r) => !r.ok).length} failed, now ${group}`);
}
const codeOf = (err: unknown) => {
  const s = JSON.stringify(err);
  const m = s?.match(/"Custom":(\d+)/);
  return m ? Number(m[1]) : s ?? "null";
};

// ---------- cheatcodes ----------
// The fork pulls unknown accounts from public mainnet RPC, which answers 429 under
// load; such a request never touched the program, so it is retried with backoff.
async function rpc(method: string, paramsJson: string) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
      body: `{"jsonrpc":"2.0","id":1,"method":"${method}","params":${paramsJson}}` });
    const j = await r.json();
    if (!j.error) return j.result;
    if (!JSON.stringify(j.error).includes("429") || attempt === 9) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
    await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
  }
}
// ONLY=G6,G9 runs just those groups (e.g. to finish a run cut short by RPC limits).
const only = process.env.ONLY?.split(",");
const run = (g: string) => !only || only.includes(g);
// amount is spliced in as raw digits so u64 values above 2^53 stay exact
const setBalance = (owner: PublicKey, amount: bigint) =>
  rpc("surfnet_setTokenAccount", `["${owner.toBase58()}","${mint.toBase58()}",{"amount":${amount}},"${TOKEN_2022_PROGRAM_ID.toBase58()}"]`);
const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
async function balance(ta: PublicKey): Promise<bigint | null> {
  const i = await conn.getAccountInfo(ta);
  return i ? unpackAccount(ta, i, TOKEN_2022_PROGRAM_ID).amount : null;
}

// ---------- ephemeral vaults ----------
type V = { owner: Keypair; master: Buffer; seed: Buffer; pda: PublicKey; bump: number; ta: PublicKey };
function mkVault(): V {
  const owner = Keypair.generate(), master = randomBytes(32), seed = randomBytes(SEED_LEN);
  const [pda, bump] = PublicKey.findProgramAddressSync([Buffer.from("qcv"), publicKeyHash(master, seed), owner.publicKey.toBuffer()], program);
  return { owner, master, seed, pda, bump, ta: ata(pda) };
}
function spendIx(v: V, dest: PublicKey, refund: PublicKey, rentTo: PublicKey, amount: bigint, vaultTa = v.ta): TransactionInstruction {
  const sig = sign(v.master, v.seed, spendDigest(program, v.pda, mint, dest, refund, rentTo, amount));
  const a = Buffer.alloc(8); a.writeBigUInt64LE(amount);
  return new TransactionInstruction({ programId: program, data: Buffer.concat([Buffer.from([0, v.bump]), v.seed, a, sig]), keys: [
    { pubkey: v.pda, isSigner: false, isWritable: true },
    { pubkey: vaultTa, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: dest, isSigner: false, isWritable: true },
    { pubkey: refund, isSigner: false, isWritable: true },
    { pubkey: rentTo, isSigner: false, isWritable: true },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: v.owner.publicKey, isSigner: true, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ] });
}
const cloneIx = (ix: TransactionInstruction) =>
  new TransactionInstruction({ programId: ix.programId, keys: ix.keys.map((k) => ({ ...k })), data: Buffer.from(ix.data) });
const budget = () => ComputeBudgetProgram.setComputeUnitLimit({ units: CU_CAP });

async function buildTx(ix: TransactionInstruction, signers: Keypair[]) {
  const tx = new Transaction().add(budget(), ix);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(payer, ...signers);
  return tx;
}
// At 100 ms slots Surfpool sometimes rejects a blockhash it just handed out. Such a
// transaction never reaches the program, so it is rebuilt with a fresh blockhash.
const staleHash = (e: unknown) => JSON.stringify(e ?? null).includes("BlockhashNotFound");
async function retryStale<T extends { err: unknown }>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const r = await run().catch((e) => ({ err: String(e?.message ?? e), cu: 0 }) as unknown as T);
    if (!staleHash(r.err) || attempt === 9) return r;
    await new Promise((res) => setTimeout(res, 200));
  }
}
/** Send for real; returns {err, cu}. */
const send = (ix: TransactionInstruction, signers: Keypair[]) => retryStale(() => sendOnce(ix, signers));
/** Simulate only (same runtime, nothing committed). */
const simulate = (ix: TransactionInstruction, signers: Keypair[]) => retryStale(() => simulateOnce(ix, signers));
async function sendOnce(ix: TransactionInstruction, signers: Keypair[]) {
  const tx = await buildTx(ix, signers);
  const sig = await conn.sendRawTransaction(tx.serialize({ requireAllSignatures: false }), { skipPreflight: true });
  // Surfpool's confirm throws the instruction error itself when the tx fails; the
  // executed result is read back from the ledger either way.
  let thrown: unknown = null;
  // A confirmation that never resolves once froze a full run for an hour; cap it so a
  // stuck transaction is recorded (it is then looked up below) instead of hanging.
  const cap = new Promise((_, rej) => setTimeout(() => rej(new Error("confirm timeout 60s")), 60_000));
  try { await Promise.race([conn.confirmTransaction(sig, "confirmed"), cap]); } catch (e) { thrown = e; }
  let t = null;
  for (let i = 0; i < 20 && !t; i++) {
    t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!t) await new Promise((r) => setTimeout(r, 100));
  }
  if (!t) return { err: thrown ?? "tx not found", cu: 0, sig };
  return { err: t.meta?.err ?? null, cu: t.meta?.computeUnitsConsumed ?? 0, sig };
}
async function simulateOnce(ix: TransactionInstruction, signers: Keypair[]) {
  const tx = await buildTx(ix, signers);
  const r = await conn.simulateTransaction(tx);
  return { err: r.value.err, cu: r.value.unitsConsumed ?? 0 };
}

/** Fresh vault funded with `bal`, plus fresh dest/refund token accounts. */
async function setup(bal: bigint) {
  const v = mkVault(), d = Keypair.generate().publicKey, r = Keypair.generate().publicKey;
  await setBalance(v.pda, bal);
  await setBalance(d, 0n);
  await setBalance(r, 0n);
  return { v, dest: ata(d), refund: ata(r) };
}
const randAmount = () => BigInt("0x" + randomBytes(7).toString("hex")) + 1n; // up to 2^56

// ============================================================================
const payerSol = (await conn.getBalance(payer.publicKey)) / 1e9;
console.log("payer", payer.publicKey.toBase58(), "SOL", payerSol);
// Without fee SOL every transaction fails before the program runs, which would show up
// as hundreds of misleading FAILs. Stop instead.
if (payerSol < 10) { console.error(`payer has ${payerSol} SOL on the fork; airdrop it first (solana airdrop 1000 ${payer.publicKey.toBase58()} -u ${RPC})`); process.exit(2); }

// G0: the fork really is mainnet
if (run("G0")) {
  const p = await conn.getAccountInfo(program);
  const m = await conn.getAccountInfo(mint);
  record("G0 fork", "program cloned from mainnet", !!p?.executable);
  record("G0 fork", "QC mint cloned from mainnet", !!m && m.owner.equals(TOKEN_2022_PROGRAM_ID));
  const probe = Keypair.generate().publicKey;
  await setBalance(probe, 777n);
  record("G0 fork", "token cheatcode works", (await balance(ata(probe))) === 777n);
}

// G1: functional spends, amounts at every edge, exact balance/marker/rent accounting
if (run("G1")) {
  const n = 150 * SCALE;
  for (let i = 0; i < n; i++) {
    const bal = i % 10 === 0 ? 1n : i % 10 === 1 ? 2n ** 64n - 1n : randAmount();
    const pick = [0n, 1n, bal - 1n, bal, bal / 2n, BigInt(randomInt(0, 1_000_000)) % (bal + 1n)][i % 6];
    const { v, dest, refund } = await setup(bal);
    const rentTo = Keypair.generate().publicKey;
    const r = await send(spendIx(v, dest, refund, rentTo, pick), [v.owner]);
    if (r.err) { record("G1 spend", `#${i} bal=${bal} amt=${pick}`, false, r.err); continue; }
    cu.push(r.cu);
    const [db, rb, vb, vp, rl] = await Promise.all([balance(dest), balance(refund), balance(v.ta), conn.getAccountInfo(v.pda), conn.getBalance(rentTo)]);
    const ok = db === pick && rb === bal - pick && vb === null && !!vp?.owner.equals(program) && vp.lamports === MARKER_RENT && vp.data.length === 0 && rl > 0;
    record("G1 spend", `#${i} bal=${bal} amt=${pick}`, ok, { db: String(db), rb: String(rb), vb: String(vb), marker: vp?.lamports, rentTo: rl });
  }
}

// G2: overspend is refused
if (run("G2")) {
  const n = 20 * SCALE;
  for (let i = 0; i < n; i++) {
    const bal = randAmount();
    const { v, dest, refund } = await setup(bal);
    const amt = i % 2 ? bal + 1n : 2n ** 64n - 1n;
    const r = await send(spendIx(v, dest, refund, payer.publicKey, amt), [v.owner]);
    record("G2 overspend", `#${i} bal=${bal} amt=${amt}`, codeOf(r.err) === 3 && (await balance(v.ta)) === bal, r.err);
  }
}

// G3: mutation fuzz. One signed message per vault, many tampered variants; none may
// succeed, the vault must keep its balance, and the untampered message must still work.
if (run("G3")) {
  const vaults = 40 * SCALE, perVault = 30;
  const decoy = Keypair.generate().publicKey; await setBalance(decoy, 5n);
  const MUTATIONS: [string, number | null, (ix: TransactionInstruction, v: V) => Keypair[]][] = [
    ["flip WOTS sig bit", 2, (ix, v) => { const o = 26 + randomInt(0, ix.data.length - 26); ix.data[o] ^= 1 << randomInt(0, 8); return [v.owner]; }],
    ["flip seed bit", 2, (ix, v) => { ix.data[2 + randomInt(0, SEED_LEN)] ^= 1 << randomInt(0, 8); return [v.owner]; }],
    ["other bump", 2, (ix, v) => { ix.data[1] = (ix.data[1] + randomInt(1, 256)) & 255; return [v.owner]; }],
    ["other amount", 2, (ix, v) => { ix.data.writeBigUInt64LE(ix.data.readBigUInt64LE(18) ^ (1n << BigInt(randomInt(0, 64))), 18); return [v.owner]; }],
    ["other opcode", 1, (ix, v) => { ix.data[0] = randomInt(1, 256); return [v.owner]; }],
    ["truncate data", 1, (ix, v) => { ix.data = ix.data.subarray(0, randomInt(0, ix.data.length)); return [v.owner]; }],
    ["extend data", 1, (ix, v) => { ix.data = Buffer.concat([ix.data, randomBytes(randomInt(1, 8))]); return [v.owner]; }],
    ["swap vault", 2, (ix, v) => { ix.keys[0].pubkey = Keypair.generate().publicKey; return [v.owner]; }],
    ["swap mint", 2, (ix, v) => { ix.keys[2].pubkey = Keypair.generate().publicKey; return [v.owner]; }],
    ["swap destination", 2, (ix, v) => { ix.keys[3].pubkey = ata(decoy); return [v.owner]; }],
    ["swap refund", 2, (ix, v) => { ix.keys[4].pubkey = ata(decoy); return [v.owner]; }],
    ["swap rent receiver", 2, (ix, v) => { ix.keys[5].pubkey = Keypair.generate().publicKey; return [v.owner]; }],
    ["legacy token program", 5, (ix, v) => { ix.keys[6].pubkey = TOKEN_PROGRAM_ID; return [v.owner]; }],
    ["random token program", 5, (ix, v) => { ix.keys[6].pubkey = Keypair.generate().publicKey; return [v.owner]; }],
    ["thief owner", 2, (ix) => { const t = Keypair.generate(); ix.keys[7].pubkey = t.publicKey; return [t]; }],
    ["owner not signing", 7, (ix) => { ix.keys[7].isSigner = false; return []; }],
    ["system program swapped", 1, (ix, v) => { ix.keys[8].pubkey = Keypair.generate().publicKey; return [v.owner]; }],
    ["drop last account", 1, (ix, v) => { ix.keys.pop(); return [v.owner]; }],
    ["extra account", 1, (ix, v) => { ix.keys.push({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false }); return [v.owner]; }],
    ["duplicate account", 6, (ix, v) => { const a = randomInt(0, 6), b = (a + randomInt(1, 6)) % 6; ix.keys[b] = { ...ix.keys[a] }; return [v.owner]; }],
    ["vault_ta not a token account", 4, (ix, v) => { ix.keys[1].pubkey = Keypair.generate().publicKey; return [v.owner]; }],
  ];
  for (let i = 0; i < vaults; i++) {
    const bal = randAmount();
    const { v, dest, refund } = await setup(bal);
    const amt = bal / 3n;
    const good = spendIx(v, dest, refund, payer.publicKey, amt);
    for (let k = 0; k < perVault; k++) {
      const [name, expect, mutate] = MUTATIONS[(i * perVault + k) % MUTATIONS.length];
      const ix = cloneIx(good);
      const signers = mutate(ix, v);
      // First pass per vault goes on chain for real; the rest are simulated.
      const r = k < MUTATIONS.length && i < 3 ? await send(ix, signers) : await simulate(ix, signers);
      const c = codeOf(r.err);
      errCodes[`${name} -> ${c}`] = (errCodes[`${name} -> ${c}`] ?? 0) + 1;
      // "extend/truncate" can land on a length that parses as a different error; any failure is a pass
      // only where the exact code is not deterministic.
      const ok = r.err !== null && (expect === null || c === expect || ((name.startsWith("duplicate") || name === "drop last account") && typeof c === "number"));
      record("G3 fuzz", `${name} (vault ${i})`, ok, { expect, got: r.err });
    }
    record("G3 fuzz", `vault ${i} balance untouched by ${perVault} attacks`, (await balance(v.ta)) === bal);
    const real = await send(good, [v.owner]);
    record("G3 fuzz", `vault ${i} genuine message still works after attacks`, real.err === null && (await balance(dest)) === amt, real.err);
    if (!real.err) cu.push(real.cu);
    // G4 inline: replay, then M-1 (re-create the token account, fund it, replay)
    const again = await send(good, [v.owner]);
    record("G4 replay", `vault ${i} replay refused`, codeOf(again.err) === 8, again.err);
    await setBalance(v.pda, 123_456n);
    const m1 = await send(good, [v.owner]);
    record("G4 replay", `vault ${i} M-1 replay onto new token account refused`, codeOf(m1.err) === 8 && (await balance(v.ta)) === 123_456n, m1.err);
  }
}

// G5: signature transplant. A valid signature from vault A must not open vault B.
if (run("G5")) {
  const n = 30 * SCALE;
  for (let i = 0; i < n; i++) {
    const a = await setup(1_000_000n), b = await setup(1_000_000n);
    const ixA = spendIx(a.v, a.dest, a.refund, payer.publicKey, 10n);
    const ix = cloneIx(spendIx(b.v, a.dest, a.refund, payer.publicKey, 10n));
    ix.data = Buffer.from(ixA.data); // A's seed+sig, B's accounts
    ix.data[1] = b.v.bump;
    const r = await simulate(ix, [b.v.owner]);
    record("G5 transplant", `#${i} sig of A on vault B`, codeOf(r.err) === 2 && (await balance(b.v.ta)) === 1_000_000n, r.err);
  }
}

// G6: concurrency. Many independent spends at once; duplicates of one tx execute once.
if (run("G6")) {
  const n = 150 * SCALE;
  const jobs = [];
  // Set up in batches of 10 (each setup makes the fork fetch 3 accounts from mainnet);
  // only the spends themselves are fired all at once.
  for (let i = 0; i < n; i += 10) jobs.push(...(await Promise.all(Array.from({ length: Math.min(10, n - i) }, (_, k) => setup(1_000_000n + BigInt(i + k))))));
  const set = jobs;
  const { blockhash } = await conn.getLatestBlockhash();
  const txs = set.map(({ v, dest, refund }) => {
    const t = new Transaction().add(budget(), spendIx(v, dest, refund, payer.publicKey, 1000n));
    t.feePayer = payer.publicKey; t.recentBlockhash = blockhash; t.sign(payer, v.owner); return t;
  });
  const t0 = Date.now();
  const sigs = await Promise.all(txs.map((t) => conn.sendRawTransaction(t.serialize(), { skipPreflight: true })));
  // the same raw tx three more times, concurrently
  const dupSigs = await Promise.all([0, 1, 2].map(() => conn.sendRawTransaction(txs[0].serialize(), { skipPreflight: true }).catch((e) => String(e))));
  // At 100 ms slots a blockhash lives ~15 s, and under this burst the fork can still be
  // fetching accounts from mainnet when it expires. A tx with no status after 20 s never
  // executed and can no longer land, so it is re-signed with a fresh blockhash. A double
  // execution would still be caught: the vault refuses a second spend and the balances
  // below must be exact.
  const current = [...sigs];
  let resent = 0;
  for (let round = 0; round < 6; round++) {
    const deadline = Date.now() + 20_000;
    let st = (await conn.getSignatureStatuses(current)).value;
    while (Date.now() < deadline && !st.every((s) => s?.confirmationStatus)) {
      await new Promise((r) => setTimeout(r, 500));
      st = (await conn.getSignatureStatuses(current)).value;
    }
    const missing = st.flatMap((s, i) => (s ? [] : [i]));
    if (!missing.length) break;
    const { blockhash: fresh } = await conn.getLatestBlockhash();
    for (const i of missing) {
      const { v, dest, refund } = set[i];
      const t = new Transaction().add(budget(), spendIx(v, dest, refund, payer.publicKey, 1000n));
      t.feePayer = payer.publicKey; t.recentBlockhash = fresh; t.sign(payer, v.owner);
      current[i] = await conn.sendRawTransaction(t.serialize(), { skipPreflight: true });
      resent++;
    }
  }
  const ms = Date.now() - t0;
  const statuses = (await conn.getSignatureStatuses(current)).value;
  const okCount = statuses.filter((s) => s && s.err === null).length;
  const balOk = (await Promise.all(set.map(async (s, i) => (await balance(s.dest)) === 1000n && (await balance(s.refund)) === 1_000_000n + BigInt(i) - 1000n))).every(Boolean);
  record("G6 concurrency", `${n} simultaneous spends all landed`, okCount === n, { okCount, ms, resentAfterExpiredBlockhash: resent });
  record("G6 concurrency", `${n} simultaneous spends: every balance exact`, balOk);
  record("G6 concurrency", "same tx submitted 4x executes once", (await balance(set[0].dest)) === 1000n, dupSigs);
}

// G7: worst-case compute. Grind amounts for the digest with the most hash steps, then run it.
if (run("G7")) {
  const { v, dest, refund } = await setup(2n ** 63n);
  const steps = (amt: bigint) => digits(spendDigest(program, v.pda, mint, dest, refund, payer.publicKey, amt)).reduce((a, d) => a + (255 - d), 0);
  let best = 0n, bestSteps = -1;
  for (let a = 0n; a < 200_000n; a++) { const s = steps(a); if (s > bestSteps) { bestSteps = s; best = a; } }
  const r = await send(spendIx(v, dest, refund, payer.publicKey, best), [v.owner]);
  record("G7 compute", `worst of 200k digests (${bestSteps} verify steps) fits under ${CU_CAP} CU`, r.err === null && r.cu < CU_CAP, { cu: r.cu, steps: bestSteps });
  if (!r.err) cu.push(r.cu);
}

// G8: real mainnet vaults in the fork, probed with public data only (no key is used).
if (run("G8")) {
  const pub = JSON.parse(readFileSync("allocations-mainnet.json", "utf8"));
  const sigs: string[] = Object.values(pub).map((x: any) => x.tx).filter(Boolean);
  const live = Object.values(pub).map((x: any) => new PublicKey(x.vault));
  for (const s of sigs) {
    // Pull the public spend instruction from mainnet, replay it as-is in the fork.
    const t = await new Connection("https://api.mainnet-beta.solana.com").getTransaction(s, { maxSupportedTransactionVersion: 0 }).catch(() => null);
    await new Promise((r) => setTimeout(r, 1500));
    if (!t) { record("G8 mainnet data", `fetch ${s.slice(0, 8)}`, false, "rpc refused"); continue; }
    const msg = t.transaction.message;
    const keys = msg.staticAccountKeys;
    const ci = msg.compiledInstructions.find((c) => keys[c.programIdIndex].equals(program))!;
    const orig = new TransactionInstruction({ programId: program, data: Buffer.from(ci.data),
      keys: ci.accountKeyIndexes.map((k, j) => ({ pubkey: keys[k], isSigner: j === 7, isWritable: [0, 1, 3, 4, 5].includes(j) })) });
    // (a) replay the executed public spend: owner signature cannot be produced, so we sign
    //     with a thief key in the owner slot -> the WOTS/PDA binding must refuse it.
    const thief = Keypair.generate();
    const a = cloneIx(orig); a.keys[7].pubkey = thief.publicKey;
    const ra = await simulate(a, [thief]);
    record("G8 mainnet data", `public spend ${s.slice(0, 8)}: replay with thief owner refused`, ra.err !== null, ra.err);
    // (b) transplant that public signature onto each live mainnet vault
    for (const target of live) {
      const b = cloneIx(orig); b.keys[0].pubkey = target; b.keys[1].pubkey = ata(target); b.keys[7].pubkey = thief.publicKey;
      const rb = await simulate(b, [thief]);
      record("G8 mainnet data", `public sig ${s.slice(0, 8)} on live vault ${target.toBase58().slice(0, 6)} refused`, ra.err !== null && rb.err !== null, rb.err);
    }
  }
}

// G9: finding F9. With the owner's Ed25519 signature (i.e. only after a quantum
// break of Ed25519, or a malicious wallet), a signed spend aimed at a decoy token
// account the PDA owns. The F9 program refuses anything but the vault's ATA (code 4);
// the 7,464-byte program before it accepted it. Set F9=old to document that behaviour.
if (run("G9")) {
  const fixed = process.env.F9 !== "old";
  const bal = 1_000_000n;
  const { v, dest, refund } = await setup(bal);
  const decoy = Keypair.generate();
  const tx = new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: decoy.publicKey, space: 165, lamports: await conn.getMinimumBalanceForRentExemption(165), programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeAccount3Instruction(decoy.publicKey, mint, v.pda, TOKEN_2022_PROGRAM_ID));
  tx.feePayer = payer.publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash; tx.sign(payer, decoy);
  const cs = await conn.sendRawTransaction(tx.serialize()); await conn.confirmTransaction(cs, "confirmed");
  // fund the decoy with the attacker's own QC
  const src = Keypair.generate(); await setBalance(src.publicKey, 500_000n);
  const t2 = new Transaction().add(createTransferCheckedInstruction(ata(src.publicKey), mint, decoy.publicKey, src.publicKey, 500_000n, DECIMALS, [], TOKEN_2022_PROGRAM_ID));
  t2.feePayer = payer.publicKey; t2.recentBlockhash = (await conn.getLatestBlockhash()).blockhash; t2.sign(payer, src);
  await conn.confirmTransaction(await conn.sendRawTransaction(t2.serialize()), "confirmed");
  const r = await send(spendIx(v, dest, refund, payer.publicKey, 100n, decoy.publicKey), [v.owner]);
  const realLeft = await balance(v.ta);
  const spent = (await conn.getAccountInfo(v.pda))?.owner.equals(program) ?? false;
  if (fixed) {
    record("G9 F9", "decoy vault token account refused with NotATokenAccount (4)", codeOf(r.err) === 4, r.err);
    record("G9 F9", "vault not marked spent, real ATA untouched", !spent && realLeft === bal, { spent, realLeft: String(realLeft) });
    const ok = await send(spendIx(v, dest, refund, payer.publicKey, 100n), [v.owner]);
    record("G9 F9", "same vault still spends normally from its ATA", ok.err === null && (await balance(dest)) === 100n, ok.err);
  } else {
    record("G9 F9", "old program: decoy accepted, real balance locked behind spent marker", r.err === null && realLeft === bal && spent, r.err);
  }
}

// ---------- report ----------
const byGroup: Record<string, { pass: number; fail: number }> = {};
for (const r of results) { const g = (byGroup[r.group] ??= { pass: 0, fail: 0 }); r.ok ? g.pass++ : g.fail++; }
const sorted = [...cu].sort((a, b) => a - b);
const report = {
  date: new Date().toISOString(), rpc: RPC, forkOf: "mainnet-beta", program: program.toBase58(), mint: mint.toBase58(),
  total: results.length, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length,
  byGroup, compute: { spends: cu.length, min: sorted[0], median: sorted[sorted.length >> 1], max: sorted[sorted.length - 1], cap: CU_CAP },
  fuzzErrorCodes: errCodes, failures: results.filter((r) => !r.ok), g9: results.filter((r) => r.group === "G9 F9"),
};
writeFileSync(new URL(`../audit/${process.env.REPORT ?? "surfpool-mainnet-fork-run"}.json`, import.meta.url), JSON.stringify(report, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2));
console.log(JSON.stringify({ total: report.total, passed: report.passed, failed: report.failed, byGroup, compute: report.compute }, null, 2));
process.exit(report.failed ? 1 : 0);
