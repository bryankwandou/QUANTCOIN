// Proves the Codama-generated client (generated/) builds the exact Spend that
// qc.ts builds (the one proven on devnet): same data bytes, accounts, roles, PDA.
// Run: npx tsx codama-check.ts
import { Keypair, PublicKey } from "@solana/web3.js";
import { address, createNoopSigner } from "@solana/kit";
import { getSpendInstruction, findVaultPda, QC_VAULT_PROGRAM_ADDRESS } from "./generated/index.ts";
import { publicKeyHash, spendDigest, spendIxs, vaultAddress, vaultTokenAccount, type VaultKeys } from "./qc.ts";
import { randomBytes } from "node:crypto";

const program = new PublicKey(QC_VAULT_PROGRAM_ADDRESS);
const mint = Keypair.generate().publicKey, dest = Keypair.generate().publicKey;
const refund = Keypair.generate().publicKey, rentTo = Keypair.generate().publicKey;
const v: VaultKeys = { name: "check", owner: Keypair.generate(), master: randomBytes(32), seed: randomBytes(16), used: false };
const amount = 123_456_789n;

// Pre-record the digest so spendIxs does not write a key file for this throwaway vault.
v.signed = spendDigest(program, vaultAddress(program, v)[0], mint, dest, refund, rentTo, amount).toString("hex");
const legacy = spendIxs(program, mint, v, dest, refund, rentTo, amount)[1];
const [pda, bump] = vaultAddress(program, v);
const [gPda, gBump] = await findVaultPda({ wotsPkHash: publicKeyHash(v.master, v.seed), owner: address(v.owner.publicKey.toBase58()) });
const a = (k: PublicKey) => address(k.toBase58());
const gen = getSpendInstruction({
  vault: a(pda), vaultTokenAccount: a(vaultTokenAccount(program, mint, v)), mint: a(mint),
  destination: a(dest), refund: a(refund), rentReceiver: a(rentTo),
  owner: createNoopSigner(a(v.owner.publicKey)),
  bump, wotsSeed: legacy.data.subarray(2, 18), amount, wotsSignature: legacy.data.subarray(26),
});

const fail = (m: string) => { console.error("MISMATCH:", m); process.exit(1); };
if (gPda !== pda.toBase58() || gBump !== bump) fail("vault PDA");
if (!Buffer.from(gen.data!).equals(legacy.data)) fail("instruction data");
if (gen.programAddress !== program.toBase58()) fail("program id");
legacy.keys.forEach((k, i) => {
  const g = gen.accounts![i];
  const role = (k.isSigner ? 2 : 0) | (k.isWritable ? 1 : 0);
  if (g.address !== k.pubkey.toBase58() || g.role !== role) fail(`account ${i}`);
});
console.log(`codama client matches qc.ts: ${gen.data!.length}-byte data, ${gen.accounts!.length} accounts, PDA ${gPda}`);
