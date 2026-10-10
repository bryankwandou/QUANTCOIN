// Spend from a hybrid vault: send AMOUNT (base units) to DEST_OWNER's QC account,
// move the rest into a fresh vault NEXT, close the old one.
// Env: RPC_URL, PAYER, PROGRAM_ID, MINT, FROM (vault name), NEXT (new vault name), DEST_OWNER, AMOUNT.
import { PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { checkSpend, env, loadVault, newVault, vaultExists, spendIxs, vaultAddress, vaultTokenAccount } from "./qc.ts";

const { conn, payer, program } = env();
const mint = new PublicKey(process.env.MINT!);
const from = loadVault(process.env.FROM!);
const next = vaultExists(process.env.NEXT!) ? loadVault(process.env.NEXT!) : newVault(process.env.NEXT!);
const destOwner = new PublicKey(process.env.DEST_OWNER!);
const amount = BigInt(process.env.AMOUNT!);
// RENT_TO: where the closed vault account's rent goes (default: the fee payer).
const rentTo = process.env.RENT_TO ? new PublicKey(process.env.RENT_TO) : payer.publicKey;
await checkSpend(conn, program, mint, from, destOwner, amount, next, rentTo);

const dest = getAssociatedTokenAddressSync(mint, destOwner, true, TOKEN_2022_PROGRAM_ID);
const nextTa = vaultTokenAccount(program, mint, next);
const prep = new Transaction().add(
  createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, dest, destOwner, mint, TOKEN_2022_PROGRAM_ID),
  createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, nextTa, vaultAddress(program, next)[0], mint, TOKEN_2022_PROGRAM_ID),
);
console.log("accounts ready", await sendAndConfirmTransaction(conn, prep, [payer]));
// A just-created account can be missing on the node that simulates the spend,
// which then fails with IncorrectProgramId. Wait until both are visible.
for (let i = 0; ; i++) {
  const [a, b] = await conn.getMultipleAccountsInfo([dest, nextTa]);
  if (a?.owner.equals(TOKEN_2022_PROGRAM_ID) && b?.owner.equals(TOKEN_2022_PROGRAM_ID)) break;
  if (i === 30) throw new Error("token accounts still not visible after 30 s");
  await new Promise((r) => setTimeout(r, 1000));
}

const tx = new Transaction().add(...spendIxs(program, mint, from, dest, nextTa, rentTo, amount));
// spendIxs records the signed digest in the key file BEFORE anything is
// broadcast. Re-running with identical parameters retries safely.
const sig = await sendAndConfirmTransaction(conn, tx, [payer, from.owner]);
const info = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
console.log({ spend: sig, computeUnits: info?.meta?.computeUnitsConsumed,
  dest: (await conn.getTokenAccountBalance(dest)).value.uiAmountString,
  nextVault: (await conn.getTokenAccountBalance(nextTa)).value.uiAmountString,
  rentTo: rentTo.toBase58(), rentToLamports: await conn.getBalance(rentTo) });
