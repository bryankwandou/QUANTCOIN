// Read-only probe against the LIVE program and LIVE rent: simulates (never sends) a
// spend of a throwaway vault whose token account is empty, once with a fresh
// rent receiver and once with an existing funded one. Signatures are not verified
// in simulation, so no real key is needed and nothing can land.
// Run: RPC_URL=<mainnet rpc> FEE_PAYER=<any funded mainnet address> npx tsx rent-probe.ts
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { randomBytes } from "node:crypto";
import { publicKeyHash, sign, spendDigest } from "./qc.ts";

const conn = new Connection(process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
const program = new PublicKey(process.env.PROGRAM_ID ?? "CiupyGrAtWomKW5rDWbaMEsm3Db8pY8NPECgL2FfACms");
const mint = new PublicKey(process.env.MINT ?? "AsEEaydVYMpghdNTrQoVZTAhJSewZT5xD9WE9hpA68W2");
const payer = new PublicKey(process.env.FEE_PAYER ?? "GKPFmq8mKvgKrHRQX5nJToZhR2AsvzgcQsgCWv9aNnoN");
const ata = (o: PublicKey) => getAssociatedTokenAddressSync(mint, o, true, TOKEN_2022_PROGRAM_ID);

async function probe(label: string, rentTo: PublicKey) {
  const owner = Keypair.generate(), master = randomBytes(32), seed = randomBytes(16);
  const [vault, bump] = PublicKey.findProgramAddressSync([Buffer.from("qcv"), publicKeyHash(master, seed), owner.publicKey.toBuffer()], program);
  const dest = ata(Keypair.generate().publicKey), refund = ata(Keypair.generate().publicKey);
  const sig = sign(master, seed, spendDigest(program, vault, mint, dest, refund, rentTo, 0n));
  const data = Buffer.concat([Buffer.from([0, bump]), seed, Buffer.alloc(8), sig]);
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    createAssociatedTokenAccountIdempotentInstruction(payer, ata(vault), vault, mint, TOKEN_2022_PROGRAM_ID),
    new TransactionInstruction({ programId: program, data, keys: [
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: ata(vault), isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: refund, isSigner: false, isWritable: true },
      { pubkey: rentTo, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: owner.publicKey, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ] }),
  ];
  const { blockhash } = await conn.getLatestBlockhash();
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
  const r = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  console.log(label, { err: r.value.err, cu: r.value.unitsConsumed, log: r.value.logs?.filter((l) => /insufficient|rent|failed|success/i.test(l)).slice(-3) });
  return r.value.err;
}

const rentSysvar = (await conn.getAccountInfo(new PublicKey("SysvarRent111111111111111111111111111111111")))!.data;
console.log({ lamportsPerByteYear: rentSysvar.readBigUInt64LE(0), threshold: rentSysvar.readDoubleLE(8), min0: await conn.getMinimumBalanceForRentExemption(0) });
await probe("fresh rent receiver   ", Keypair.generate().publicKey);
await new Promise((r) => setTimeout(r, 1500));
await probe("existing rent receiver", payer);
