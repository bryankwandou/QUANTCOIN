// Prints reference values for apps/native/test/xcheck_test.dart. Fixed, non-secret test keys.
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { publicKeyHash, spendIxs, vaultAddress, vaultTokenAccount, spendDigest, type VaultKeys } from "./qc.ts";
const program = new PublicKey("CiupyGrAtWomKW5rDWbaMEsm3Db8pY8NPECgL2FfACms");
const mint = new PublicKey("BUoNsFbNU5hxYK5rRoiHkFqonaoaNL836Wo5QgrukAK8");
const fill = (n: number, b: number) => Buffer.alloc(n, b);
const mk = (o: number, m: number, s: number): VaultKeys => ({ name: "x", owner: Keypair.fromSeed(fill(32, o)), master: fill(32, m), seed: fill(16, s), used: true, signed: undefined });
const from = mk(1, 2, 3), next = mk(1, 4, 5), payer = Keypair.fromSeed(fill(32, 9));
const recipient = new PublicKey("7Xu64rz6VvqzGK9TtwWh4C9DAsp3WZTec2MWNpuYosh2");
const amount = 123456789n, bh = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
const [pda] = vaultAddress(program, from), dest = getAssociatedTokenAddressSync(mint, recipient, true, TOKEN_2022_PROGRAM_ID);
const nextTa = vaultTokenAccount(program, mint, next);
const prep = new Transaction({ feePayer: payer.publicKey, recentBlockhash: bh }).add(
  createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, dest, recipient, mint, TOKEN_2022_PROGRAM_ID),
  createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, nextTa, vaultAddress(program, next)[0], mint, TOKEN_2022_PROGRAM_ID));
// spendIxs would write a key file; avoid saveVault by pre-setting signed to the right digest.
from.signed = spendDigest(program, pda, mint, dest, nextTa, payer.publicKey, amount).toString("hex");
const spend = new Transaction({ feePayer: payer.publicKey, recentBlockhash: bh }).add(...spendIxs(program, mint, from, dest, nextTa, payer.publicKey, amount));
spend.sign(payer, from.owner);
console.log(JSON.stringify({
  pkHash: publicKeyHash(from.master, from.seed).toString("hex"), vault: pda.toBase58(), owner: from.owner.publicKey.toBase58(),
  payer: payer.publicKey.toBase58(), nextTa: nextTa.toBase58(), digest: from.signed,
  prepMsg: prep.serializeMessage().toString("base64"), spendMsg: spend.serializeMessage().toString("base64"),
  spendTx: spend.serialize().toString("base64"),
}, null, 1));
