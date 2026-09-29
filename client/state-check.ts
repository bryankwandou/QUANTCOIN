import { PublicKey } from "@solana/web3.js";
import { env, loadVault, vaultAddress, vaultTokenAccount } from "./qc.ts";
const { conn, program } = env();
const mint = new PublicKey(process.env.MINT!);
for (const n of process.argv.slice(2)) {
  const v = loadVault(n); const pda = vaultAddress(program, v)[0]; const ta = vaultTokenAccount(program, mint, v);
  const acc = await conn.getAccountInfo(pda); const tai = await conn.getAccountInfo(ta);
  const bal = tai ? (await conn.getTokenAccountBalance(ta)).value.uiAmountString : "-";
  console.log(n.padEnd(18), pda.toBase58(), acc?.owner.equals(program) ? "SPENT" : "open ", "TA:", tai ? bal : "none");
  await new Promise(r => setTimeout(r, 1500));
}
