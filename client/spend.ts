// Spend from a hybrid vault: send AMOUNT (base units) to DEST_OWNER's QC account,
// move the rest into a fresh vault NEXT, close the old one.
// Env: RPC_URL, PAYER, PROGRAM_ID, MINT, FROM (vault name), NEXT (new vault name), DEST_OWNER, AMOUNT.
import { PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { env, loadVault, newVault, saveVault, spendIxs, vaultAddress, vaultTokenAccount } from "./qc.ts";

const { conn, payer, program } = env();
const mint = new PublicKey(process.env.MINT!);
const from = loadVault(process.env.FROM!);
const next = newVault(process.env.NEXT!);
const destOwner = new PublicKey(process.env.DEST_OWNER!);
const amount = BigInt(process.env.AMOUNT!);

const dest = getAssociatedTokenAddressSync(mint, destOwner, true, TOKEN_2022_PROGRAM_ID);
const nextTa = vaultTokenAccount(program, mint, next);
const prep = new Transaction().add(
  createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, dest, destOwner, mint, TOKEN_2022_PROGRAM_ID),
  createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, nextTa, vaultAddress(program, next)[0], mint, TOKEN_2022_PROGRAM_ID),
);
console.log("accounts ready", await sendAndConfirmTransaction(conn, prep, [payer]));

const tx = new Transaction().add(...spendIxs(program, mint, from, dest, nextTa, payer.publicKey, amount));
// Mark the key used BEFORE broadcasting: a WOTS key must never sign twice.
from.used = true;
saveVault(from);
const sig = await sendAndConfirmTransaction(conn, tx, [payer, from.owner]);
const info = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
console.log({ spend: sig, computeUnits: info?.meta?.computeUnitsConsumed,
  dest: (await conn.getTokenAccountBalance(dest)).value.uiAmountString,
  nextVault: (await conn.getTokenAccountBalance(nextTa)).value.uiAmountString });
