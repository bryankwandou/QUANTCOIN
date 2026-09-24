// Split the treasury vault into allocation vaults, one hybrid spend per allocation.
// Each step: amount -> fresh allocation vault, remainder -> fresh treasury vault.
// Env: RPC_URL, PAYER, PROGRAM_ID, MINT, FROM (current treasury vault name).
import { PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { writeFileSync } from "node:fs";
import { env, loadVault, newVault, vaultExists, spendIxs, vaultAddress, vaultTokenAccount } from "./qc.ts";

const { conn, payer, program } = env();
const mint = new PublicKey(process.env.MINT!);
const UNIT = 100_000n; // 5 decimals
const PLAN: [string, bigint][] = [ // % of 22T supply
  ["alloc-founder", 2_200_000_000_000n],   // 10%
  ["alloc-liquidity", 4_400_000_000_000n], // 20%
  ["alloc-airdrop", 3_300_000_000_000n],   // 15%
  ["alloc-reserve", 2_200_000_000_000n],   // 10%
];
const load = (n: string) => (vaultExists(n) ? loadVault(n) : newVault(n));
let from = loadVault(process.env.FROM!);
let t = Number(process.env.FROM!.split("-").pop());
const out: Record<string, unknown> = {};
for (const [name, qc] of PLAN) {
  const alloc = load(name), next = load(`treasury-${++t}`);
  const dest = vaultTokenAccount(program, mint, alloc), refund = vaultTokenAccount(program, mint, next);
  await sendAndConfirmTransaction(conn, new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, dest, vaultAddress(program, alloc)[0], mint, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, refund, vaultAddress(program, next)[0], mint, TOKEN_2022_PROGRAM_ID)), [payer]);
  const sig = await sendAndConfirmTransaction(conn,
    new Transaction().add(...spendIxs(program, mint, from, dest, refund, payer.publicKey, qc * UNIT)), [payer, from.owner]);
  out[name] = { vault: vaultAddress(program, alloc)[0].toBase58(), tokenAccount: dest.toBase58(),
    balance: (await conn.getTokenAccountBalance(dest)).value.uiAmountString, tx: sig };
  console.log(name, out[name]);
  from = next;
}
out.treasury = { name: from.name, vault: vaultAddress(program, from)[0].toBase58(),
  tokenAccount: vaultTokenAccount(program, mint, from).toBase58(),
  balance: (await conn.getTokenAccountBalance(vaultTokenAccount(program, mint, from))).value.uiAmountString };
console.log(out.treasury);
writeFileSync("allocations-devnet.json", JSON.stringify(out, null, 2));
