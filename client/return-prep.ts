// Create a fresh founder vault and its QC token account, so a holder can send QC back into a vault.
// Env: QC_NET=mainnet, RPC_URL, PAYER, PROGRAM_ID, MINT, NAME (new vault name).
import { PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { env, newVault, vaultAddress, vaultTokenAccount } from "./qc.ts";

const { conn, payer, program } = env();
const mint = new PublicKey(process.env.MINT!);
const v = newVault(process.env.NAME!);
const [vault] = vaultAddress(program, v), ta = vaultTokenAccount(program, mint, v);
const sig = await sendAndConfirmTransaction(conn, new Transaction().add(
  createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ta, vault, mint, TOKEN_2022_PROGRAM_ID)), [payer]);
console.log({ name: v.name, vault: vault.toBase58(), tokenAccount: ta.toBase58(), tx: sig });
