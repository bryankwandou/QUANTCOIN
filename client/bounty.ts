// Move AMOUNT QC from the reserve vault into a public bug-bounty vault.
// Anyone who can drain the bounty vault without both keys keeps the QC.
// Env: RPC_URL, PAYER, PROGRAM_ID, MINT, FROM, NEXT, AMOUNT (whole QC).
import { PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { writeFileSync } from "node:fs";
import { env, loadVault, newVault, vaultExists, spendIxs, vaultAddress, vaultTokenAccount } from "./qc.ts";

const { conn, payer, program } = env();
const mint = new PublicKey(process.env.MINT!);
const load = (n: string) => (vaultExists(n) ? loadVault(n) : newVault(n));
const from = loadVault(process.env.FROM!), bounty = load("bounty"), next = load(process.env.NEXT!);
const dest = vaultTokenAccount(program, mint, bounty), refund = vaultTokenAccount(program, mint, next);
await sendAndConfirmTransaction(conn, new Transaction().add(
  createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, dest, vaultAddress(program, bounty)[0], mint, TOKEN_2022_PROGRAM_ID),
  createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, refund, vaultAddress(program, next)[0], mint, TOKEN_2022_PROGRAM_ID)), [payer]);
const tx = await sendAndConfirmTransaction(conn,
  new Transaction().add(...spendIxs(program, mint, from, dest, refund, payer.publicKey, BigInt(process.env.AMOUNT!) * 100_000n)), [payer, from.owner]);
const out = { bountyVault: vaultAddress(program, bounty)[0].toBase58(), bountyTokenAccount: dest.toBase58(),
  ownerPublicKey: bounty.owner.publicKey.toBase58(), wotsSeed: bounty.seed.toString("hex"),
  balance: (await conn.getTokenAccountBalance(dest)).value.uiAmountString,
  reserveNow: { name: next.name, vault: vaultAddress(program, next)[0].toBase58(), tokenAccount: refund.toBase58(),
    balance: (await conn.getTokenAccountBalance(refund)).value.uiAmountString }, tx };
console.log(out);
writeFileSync("bounty-devnet.json", JSON.stringify(out, null, 2));
