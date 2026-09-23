// Live attack run against the DEPLOYED devnet program.
//  1. Legit spend from the treasury: 1,000 QC into a throwaway "audit" vault,
//     rest into a fresh treasury vault (NEXT).
//  2. Attack the audit vault: every attack must fail with the expected error.
//     Attacks run as real on-chain transactions (skipPreflight) so failures are
//     recorded on the explorer. Only ONE message is ever signed by the audit key.
//  3. Execute that one message for real, then replay it: replay must fail.
// Env: RPC_URL, PAYER, PROGRAM_ID, MINT, FROM (treasury vault), NEXT (new treasury name).
import { Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { writeFileSync } from "node:fs";
import { env, loadVault, newVault, vaultExists, spendIxs, vaultAddress, vaultTokenAccount, type VaultKeys } from "./qc.ts";

const { conn, payer, program } = env();
const mint = new PublicKey(process.env.MINT!);
const report: any = { date: new Date().toISOString(), program: program.toBase58(), mint: mint.toBase58(), steps: [] };
const log = (x: any) => { console.log(x); report.steps.push(x); };
const get = (n: string) => (vaultExists(n) ? loadVault(n) : newVault(n));
const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
const bal = async (a: PublicKey) => (await conn.getTokenAccountBalance(a).catch(() => null))?.value.amount ?? "closed";

async function prepare(owners: PublicKey[]) {
  const tx = new Transaction();
  for (const o of owners) tx.add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(o), o, mint, TOKEN_2022_PROGRAM_ID));
  await sendAndConfirmTransaction(conn, tx, [payer]);
}

// --- 1. fund the audit vault through a legit treasury spend -----------------
const from = loadVault(process.env.FROM!);
const next = get(process.env.NEXT!);
const audit = get("audit-target");
const auditPda = vaultAddress(program, audit)[0];
const auditTa = vaultTokenAccount(program, mint, audit);
const nextTa = vaultTokenAccount(program, mint, next);
if ((await bal(auditTa)) === "closed" || (await bal(auditTa)) === "0") {
  await prepare([auditPda, vaultAddress(program, next)[0]]);
  const fund = 1_000n * 100_000n;
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(
    ...spendIxs(program, mint, from, auditTa, nextTa, payer.publicKey, fund)), [payer, from.owner]);
  log({ step: "fund audit vault via legit treasury spend", tx: sig, auditVault: await bal(auditTa), newTreasury: await bal(nextTa) });
}

// --- 2. attacks ---------------------------------------------------------------
const alice = Keypair.generate().publicKey, bob = Keypair.generate().publicKey, evil = Keypair.generate().publicKey;
await prepare([alice, bob, evil]);
const dest = ata(alice), refund = ata(bob), evilTa = ata(evil);
const AMOUNT = 600n * 100_000n;
const good = () => spendIxs(program, mint, audit, dest, refund, payer.publicKey, AMOUNT);
const before = await bal(auditTa);

async function attack(name: string, expect: string, build: (ix: TransactionInstruction) => { ix: TransactionInstruction; signers: Keypair[] }) {
  const [cb, ix0] = good();
  const ix = new TransactionInstruction({ programId: ix0.programId, keys: ix0.keys.map((k) => ({ ...k })), data: Buffer.from(ix0.data) });
  const { ix: bad, signers } = build(ix);
  const tx = new Transaction().add(cb, bad);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  let sig = "", err = "";
  try {
    tx.sign(payer, ...signers);
    sig = await conn.sendRawTransaction(tx.serialize({ requireAllSignatures: false }), { skipPreflight: true });
    const r = await conn.confirmTransaction(sig, "confirmed");
    err = JSON.stringify(r.value.err);
  } catch (e: any) { err = "rejected before execution: " + String(e.message ?? e).split("\n")[0]; }
  const ok = err !== "null" && err.includes(expect);
  log({ attack: name, expected: expect, got: err, tx: sig || undefined, blocked: ok });
  if (!ok) { report.fail = true; }
}

const thief = Keypair.generate();
await attack("no Ed25519 owner signature (WOTS only)", "7", (ix) => { ix.keys[7].isSigner = false; return { ix, signers: [] }; });
await attack("thief replaces owner key", "2", (ix) => { ix.keys[7].pubkey = thief.publicKey; return { ix, signers: [thief] }; });
await attack("redirect destination to attacker", "2", (ix) => { ix.keys[3].pubkey = evilTa; return { ix, signers: [audit.owner] }; });
await attack("redirect refund to attacker", "2", (ix) => { ix.keys[4].pubkey = evilTa; return { ix, signers: [audit.owner] }; });
await attack("redirect rent to attacker", "2", (ix) => { ix.keys[5].pubkey = evil; return { ix, signers: [audit.owner] }; });
await attack("raise amount after signing", "2", (ix) => { ix.data.writeBigUInt64LE(AMOUNT * 2n, 18); return { ix, signers: [audit.owner] }; });
await attack("flip one WOTS signature bit", "2", (ix) => { ix.data[300] ^= 1; return { ix, signers: [audit.owner] }; });
await attack("change WOTS seed", "2", (ix) => { ix.data[5] ^= 1; return { ix, signers: [audit.owner] }; });
await attack("wrong bump", "2", (ix) => { ix.data[1] ^= 1; return { ix, signers: [audit.owner] }; });
await attack("legacy SPL Token as token program", "5", (ix) => { ix.keys[6].pubkey = TOKEN_PROGRAM_ID; return { ix, signers: [audit.owner] }; });
await attack("destination == refund", "6", (ix) => { ix.keys[4].pubkey = dest; return { ix, signers: [audit.owner] }; });
await attack("truncated instruction", "1", (ix) => { ix.data = ix.data.subarray(0, ix.data.length - 1); return { ix, signers: [audit.owner] }; });
log({ step: "vault balance unchanged after all attacks", before, after: await bal(auditTa), attackerGot: await bal(evilTa) });

// --- 3. the one legit spend, then replay -------------------------------------
const real = await sendAndConfirmTransaction(conn, new Transaction().add(...good()), [payer, audit.owner]);
log({ step: "legit spend of the signed message", tx: real, dest: await bal(dest), refund: await bal(refund), vault: await bal(auditTa) });
await attack("replay the executed spend", "", (ix) => ({ ix, signers: [audit.owner] }));

const pass = !report.fail;
report.result = pass ? "ALL ATTACKS BLOCKED" : "ATTACK SUCCEEDED OR WRONG ERROR — SEE LOG";
writeFileSync(new URL("../audit/devnet-attack-run.json", import.meta.url), JSON.stringify(report, null, 2));
console.log(report.result);
process.exit(pass ? 0 : 1);
