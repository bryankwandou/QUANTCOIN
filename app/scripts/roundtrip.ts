// Real devnet round trip through the app's own modules (store/seal/vault/flow).
// A throwaway keypair plays the wallet. Because QC cannot be obtained here, it creates
// its own Token-2022 test mint (5 decimals); the vault program accepts any Token-2022 mint.
// Env: PAYER (funding keypair file), RPC_URL (optional). Never prints secret keys.
import "../src/polyfill";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createMint, mintTo, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { PROGRAM_ID } from "../src/lib/config";
import { createVault, getVault, putVault, useStorage } from "../src/lib/store";
import { FlowCtx, balanceOf, withdraw } from "../src/lib/flow";
import { depositIxs, tokenAccountOf } from "../src/lib/vault";

const mem = new Map<string, string>();
useStorage({ getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) });

const conn = new Connection(process.env.RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.PAYER ?? `${homedir()}/.config/solana/bersih-devnet.json`, "utf8"))));
const owner = Keypair.generate();
const password = "roundtrip-" + Math.random().toString(36).slice(2);
const DEC = 5;

const send = (ixs: TransactionInstruction[], signers: Keypair[]) =>
  sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: "confirmed" });

const ctx: FlowCtx = {
  conn, program: PROGRAM_ID, mint: PublicKey.default, owner: owner.publicKey,
  send: (ixs, label) => send(ixs, [owner]).then((s) => (console.log(`  ${label}: ${s}`), s)),
  sendAs: (ixs, signer, label) => send(ixs, [signer]).then((s) => (console.log(`  ${label}: ${s}`), s)),
  backup: async (r) => { putVault({ ...getVault(r.id)!, backedUp: true }); console.log(`  (backup of next vault ${r.id} would download here)`); },
  log: (m) => console.log("  " + m),
};

const ok = (c: boolean, m: string) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) process.exitCode = 1; };

console.log("throwaway owner", owner.publicKey.toBase58());
await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: owner.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL })], [payer]);

const mint = await createMint(conn, owner, owner.publicKey, null, DEC, undefined, { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
ctx.mint = mint;
console.log("test mint", mint.toBase58());
const ownerTa = await getOrCreateAssociatedTokenAccount(conn, owner, mint, owner.publicKey, false, "confirmed", undefined, TOKEN_2022_PROGRAM_ID);
await mintTo(conn, owner, mint, ownerTa.address, owner, 1000_00000n, [], { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);

const { record: a } = await createVault(PROGRAM_ID, mint, owner.publicKey, password);
putVault({ ...a, backedUp: true });
console.log("vault A", a.id, "ata", a.ata);
console.log("deposit", await send(depositIxs(mint, DEC, owner.publicKey, new PublicKey(a.id), 100_00000n), [owner]));
ok((await balanceOf(conn, new PublicKey(a.ata))) === 100_00000n, "vault A holds 100");

const solBefore = await conn.getBalance(owner.publicKey);
const res = await withdraw(ctx, getVault(a.id)!, 30_00000n, password);
const tx = await conn.getSignaturesForAddress(new PublicKey(a.ata), { limit: 1 });
const info = tx[0] && await conn.getTransaction(tx[0].signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
console.log("spend compute units", info?.meta?.computeUnitsConsumed);
ok((await balanceOf(conn, new PublicKey(a.ata))) === null, "vault A token account closed");
ok((await balanceOf(conn, tokenAccountOf(mint, owner.publicKey))) === 930_00000n, "wallet received 30 (930 total)");
ok((await balanceOf(conn, new PublicKey(res.next.ata))) === 70_00000n, "next vault B holds the remaining 70");
ok(getVault(a.id)!.status === "spent", "vault A marked spent");
console.log("  SOL delta for owner (fees+ATA rent, incl. swept rent back):", (await conn.getBalance(owner.publicKey)) - solBefore, "lamports");

try { await withdraw(ctx, getVault(a.id)!, 1n, password); ok(false, "reuse of spent vault refused"); }
catch (e) { ok(true, `reuse of spent vault refused (${(e as Error).message})`); }
// One-time rule on a signed-but-unsent vault: different amount must be refused.
const b = getVault(res.next.id)!;
putVault({ ...b, signed: "00".repeat(24), pending: { amount: "5", dest: "", refund: "", rentTo: "", nextId: "x", digest: "00".repeat(24) } });
try { await withdraw(ctx, getVault(b.id)!, 6n, password); ok(false, "different digest refused"); }
catch (e) { ok(/exact spend/.test((e as Error).message), `different amount after signing refused (${(e as Error).message})`); }
putVault(b);

// Spend B entirely back to the wallet (vault C gets 0), exercising a second hop.
const res2 = await withdraw(ctx, getVault(b.id)!, 70_00000n, password);
ok((await balanceOf(conn, tokenAccountOf(mint, owner.publicKey))) === 1000_00000n, "second hop: wallet back to 1000");
ok((await balanceOf(conn, new PublicKey(res2.next.ata))) === 0n, "vault C exists with 0");

const left = await conn.getBalance(owner.publicKey);
if (left > 5000) await send([SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: payer.publicKey, lamports: left - 5000 })], [owner]);
console.log("returned", (left - 5000) / LAMPORTS_PER_SOL, "SOL to payer");
