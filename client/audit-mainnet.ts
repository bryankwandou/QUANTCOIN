// Live attack run against the MAINNET program, aimed at the real treasury vault.
// The one message the treasury key signs is a rotation: amount 0 to `dest`,
// the whole balance to a fresh treasury vault. Every attack tampers with that
// message; "attacker" accounts are our own vaults, so a successful attack
// could not lose funds. Then the message runs for real and is replayed.
// Attacks are sent with skipPreflight so each failure is on the explorer.
// Env: QC_NET=mainnet, RPC_URL, PAYER, PROGRAM_ID, MINT, FROM, NEXT, DEST (vault name), EVIL (vault name).
import { Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { writeFileSync } from "node:fs";
import { NET, env, loadVault, newVault, vaultExists, spendIxs, vaultAddress, vaultTokenAccount } from "./qc.ts";

const { conn, payer, program } = env();
const mint = new PublicKey(process.env.MINT!);
const report: any = { date: new Date().toISOString(), network: NET, program: program.toBase58(), mint: mint.toBase58(), steps: [] };
const log = (x: any) => { console.log(x); report.steps.push(x); };
const pause = () => new Promise((r) => setTimeout(r, 2500)); // public RPC rate limit
const bal = async (a: PublicKey) => { await pause(); return (await conn.getTokenAccountBalance(a).catch(() => null))?.value.amount ?? "closed"; };

const from = loadVault(process.env.FROM!);
const next = vaultExists(process.env.NEXT!) ? loadVault(process.env.NEXT!) : newVault(process.env.NEXT!);
const ta = (n: string) => vaultTokenAccount(program, mint, loadVault(n));
const fromTa = vaultTokenAccount(program, mint, from), nextTa = vaultTokenAccount(program, mint, next);
const dest = ta(process.env.DEST!), evilTa = ta(process.env.EVIL!);
const evil = vaultAddress(program, loadVault(process.env.EVIL!))[0];

await sendAndConfirmTransaction(conn, new Transaction().add(
  createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, nextTa, vaultAddress(program, next)[0], mint, TOKEN_2022_PROGRAM_ID)), [payer]);

const good = () => spendIxs(program, mint, from, dest, nextTa, payer.publicKey, 0n);
const before = await bal(fromTa), destBefore = await bal(dest), evilBefore = await bal(evilTa);
log({ step: "target", vault: vaultAddress(program, from)[0].toBase58(), balance: before });

async function attack(name: string, code: number, build: (ix: TransactionInstruction) => { ix: TransactionInstruction; signers: Keypair[] }) {
  const [cb, ix0] = good();
  const ix = new TransactionInstruction({ programId: ix0.programId, keys: ix0.keys.map((k) => ({ ...k })), data: Buffer.from(ix0.data) });
  const { ix: bad, signers } = build(ix);
  const tx = new Transaction().add(cb, bad);
  tx.feePayer = payer.publicKey;
  await pause();
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  let sig = "", err = "";
  try {
    tx.sign(payer, ...signers);
    sig = await conn.sendRawTransaction(tx.serialize({ requireAllSignatures: false }), { skipPreflight: true });
    err = JSON.stringify((await conn.confirmTransaction(sig, "confirmed")).value.err);
  } catch (e: any) {
    // A flaky confirm (rate limit, websocket) says nothing about the tx: ask the chain.
    const st = sig ? (await pause(), await conn.getSignatureStatus(sig, { searchTransactionHistory: true })).value : null;
    err = st ? JSON.stringify(st.err) : "rejected before execution: " + String(e?.message ?? JSON.stringify(e)).split("\n")[0];
  }
  const ok = err.includes(`{"Custom":${code}}`);
  log({ attack: name, expected: code, got: err, tx: sig || undefined, blocked: ok });
  if (!ok) report.fail = true;
}

const thief = Keypair.generate();
await attack("no Ed25519 owner signature (WOTS only)", 7, (ix) => { ix.keys[7].isSigner = false; return { ix, signers: [] }; });
await attack("thief replaces owner key", 2, (ix) => { ix.keys[7].pubkey = thief.publicKey; return { ix, signers: [thief] }; });
await attack("redirect destination", 2, (ix) => { ix.keys[3].pubkey = evilTa; return { ix, signers: [from.owner] }; });
await attack("redirect refund (whole balance)", 2, (ix) => { ix.keys[4].pubkey = evilTa; return { ix, signers: [from.owner] }; });
await attack("redirect rent", 2, (ix) => { ix.keys[5].pubkey = evil; return { ix, signers: [from.owner] }; });
await attack("raise amount after signing", 2, (ix) => { ix.data.writeBigUInt64LE(1_000_000n * 100_000n, 18); return { ix, signers: [from.owner] }; });
await attack("flip one WOTS signature bit", 2, (ix) => { ix.data[300] ^= 1; return { ix, signers: [from.owner] }; });
await attack("change WOTS seed", 2, (ix) => { ix.data[5] ^= 1; return { ix, signers: [from.owner] }; });
await attack("wrong bump", 2, (ix) => { ix.data[1] ^= 1; return { ix, signers: [from.owner] }; });
await attack("legacy SPL Token as token program", 5, (ix) => { ix.keys[6].pubkey = TOKEN_PROGRAM_ID; return { ix, signers: [from.owner] }; });
await attack("destination == refund", 6, (ix) => { ix.keys[3].pubkey = nextTa; return { ix, signers: [from.owner] }; });
await attack("truncated instruction", 1, (ix) => { ix.data = ix.data.subarray(0, ix.data.length - 1); return { ix, signers: [from.owner] }; });
log({ step: "balances unchanged after attacks", vault: [before, await bal(fromTa)], dest: [destBefore, await bal(dest)], evil: [evilBefore, await bal(evilTa)] });

await pause();
const real = await sendAndConfirmTransaction(conn, new Transaction().add(...good()), [payer, from.owner]);
log({ step: "legit rotation of the signed message", tx: real, oldVault: await bal(fromTa), newVault: await bal(nextTa), dest: await bal(dest) });
await attack("replay the executed spend", 8, (ix) => ({ ix, signers: [from.owner] }));

report.result = report.fail ? "ATTACK SUCCEEDED OR WRONG ERROR — SEE LOG" : "ALL ATTACKS BLOCKED";
writeFileSync(new URL(`../audit/${NET}-attack-run.json`, import.meta.url), JSON.stringify(report, null, 2));
console.log(report.result);
process.exit(report.fail ? 1 : 0);
