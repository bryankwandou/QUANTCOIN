// Shared helpers for the Surfpool fork scripts (fork-memo.ts, fork-extra.ts).
import {
  AddressLookupTableAccount, AddressLookupTableProgram, TransactionMessage, VersionedTransaction,
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ExtensionType, TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createEnableRequiredMemoTransfersInstruction, createReallocateInstruction, getAssociatedTokenAddressSync, unpackAccount,
} from "@solana/spl-token";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { SEED_LEN, publicKeyHash, sign, spendDigest } from "./qc.ts";

export const RPC = process.env.SURF_RPC ?? "http://127.0.0.1:8899";
export const conn = new Connection(RPC, "confirmed");
export const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.SURF_PAYER!, "utf8"))));
export const program = new PublicKey("CiupyGrAtWomKW5rDWbaMEsm3Db8pY8NPECgL2FfACms");
export const mint = new PublicKey("AsEEaydVYMpghdNTrQoVZTAhJSewZT5xD9WE9hpA68W2");
export const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const MEMO_V1 = new PublicKey("Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo");

export async function rpc(method: string, params: unknown[]) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then(x => x.json());
  if (r.error) throw new Error(`${method}: ${JSON.stringify(r.error)}`);
  return r.result;
}
export const ata = (o: PublicKey) => getAssociatedTokenAddressSync(mint, o, true, TOKEN_2022_PROGRAM_ID);
export const bal = async (ta: PublicKey) => {
  const i = await conn.getAccountInfo(ta);
  return i ? unpackAccount(ta, i, TOKEN_2022_PROGRAM_ID).amount : null;
};
// Fork blockhashes expire under load; such a transaction never ran, so it is retried.
const expired = (e: string) => /block height exceeded|BlockhashNotFound|Blockhash not found/.test(e);
async function confirmLogs(sig: string) {
  const t = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  return { err: null as string | null, cu: t?.meta?.computeUnitsConsumed ?? 0, logs: t?.meta?.logMessages ?? [] };
}
export const send = async (ixs: TransactionInstruction[], signers: Keypair[] = []) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await confirmLogs(await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [payer, ...signers]));
    } catch (e: any) {
      const err = String(e?.message ?? e) + JSON.stringify(e?.logs ?? []);
      if (!expired(err) || attempt === 5) return { err, cu: 0, logs: [] as string[] };
    }
  }
};
/** v0 transaction resolving accounts through lookup table `alt`. */
export const sendV0 = async (ixs: TransactionInstruction[], signers: Keypair[], alt: AddressLookupTableAccount) => {
  for (let attempt = 0; ; attempt++) {
    try {
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
      const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs })
        .compileToV0Message([alt]);
      const tx = new VersionedTransaction(msg);
      tx.sign([payer, ...signers]);
      const size = tx.serialize().length;
      const sig = await conn.sendTransaction(tx);
      const c = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      if (c.value.err) return { err: JSON.stringify(c.value.err), cu: 0, logs: [] as string[], size };
      return { ...(await confirmLogs(sig)), size };
    } catch (e: any) {
      const err = String(e?.message ?? e) + JSON.stringify(e?.logs ?? []);
      if (!expired(err) || attempt === 5) return { err, cu: 0, logs: [] as string[], size: 0 };
    }
  }
};
/** Creates and fills a lookup table, then waits until it is usable. */
export async function makeAlt(addresses: PublicKey[]) {
  const slot = await conn.getSlot("finalized");
  const [create, table] = AddressLookupTableProgram.createLookupTable({ authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot });
  const extend = AddressLookupTableProgram.extendLookupTable({ lookupTable: table, authority: payer.publicKey, payer: payer.publicKey, addresses });
  const r = await send([create, extend]);
  if (r.err) throw new Error("alt: " + r.err);
  const start = await conn.getSlot();
  while ((await conn.getSlot()) <= start + 1) await new Promise(res => setTimeout(res, 300));
  return (await conn.getAddressLookupTable(table)).value!;
}

export type V = { owner: Keypair; master: Buffer; seed: Buffer; pda: PublicKey; bump: number; ta: PublicKey };
export function mkVault(): V {
  const owner = Keypair.generate(), master = randomBytes(32), seed = randomBytes(SEED_LEN);
  const [pda, bump] = PublicKey.findProgramAddressSync([Buffer.from("qcv"), publicKeyHash(master, seed), owner.publicKey.toBuffer()], program);
  return { owner, master, seed, pda, bump, ta: ata(pda) };
}
export async function fund(v: V, amount: bigint) {
  await rpc("surfnet_setTokenAccount", [v.pda.toBase58(), mint.toBase58(), { amount: Number(amount) }, TOKEN_2022_PROGRAM_ID.toBase58()]);
}
export function spendIx(v: V, dest: PublicKey, refund: PublicKey, amount: bigint, memo?: PublicKey,
  o: { rentTo?: PublicKey; ownerSigns?: boolean; sig?: Buffer } = {}) {
  const rentTo = o.rentTo ?? payer.publicKey;
  const sig = o.sig ?? sign(v.master, v.seed, spendDigest(program, v.pda, mint, dest, refund, rentTo, amount));
  const a = Buffer.alloc(8); a.writeBigUInt64LE(amount);
  const keys = [
    { pubkey: v.pda, isSigner: false, isWritable: true },
    { pubkey: v.ta, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: dest, isSigner: false, isWritable: true },
    { pubkey: refund, isSigner: false, isWritable: true },
    { pubkey: rentTo, isSigner: false, isWritable: true },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: v.owner.publicKey, isSigner: o.ownerSigns ?? true, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  if (memo) keys.push({ pubkey: memo, isSigner: false, isWritable: false });
  return [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    new TransactionInstruction({ programId: program, data: Buffer.concat([Buffer.from([0, v.bump]), v.seed, a, sig]), keys })];
}
/** A wallet whose QC account requires incoming memos (or not). */
export async function wallet(memoRequired: boolean) {
  const w = Keypair.generate(), ta = ata(w.publicKey);
  const ixs = [createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ta, w.publicKey, mint, TOKEN_2022_PROGRAM_ID)];
  if (memoRequired) ixs.push(
    createReallocateInstruction(ta, payer.publicKey, [ExtensionType.MemoTransfer], w.publicKey, [], TOKEN_2022_PROGRAM_ID),
    createEnableRequiredMemoTransfersInstruction(ta, w.publicKey, [], TOKEN_2022_PROGRAM_ID));
  const r = await send(ixs, [w]);
  if (r.err) throw new Error("wallet setup: " + r.err);
  return { w, ta };
}
/** A next vault whose token account exists, optionally memo-required (a vault PDA cannot sign, so that
 *  case uses an ordinary memo-required wallet as refund: the program treats refund as any token account). */
export async function refundTa(memoRequired: boolean) {
  if (memoRequired) return (await wallet(true)).ta;
  const n = mkVault();
  const r = await send([createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, n.ta, n.pda, mint, TOKEN_2022_PROGRAM_ID)]);
  if (r.err) throw new Error("refund setup: " + r.err);
  return n.ta;
}

export const spent = async (v: V) => (await conn.getAccountInfo(v.pda))?.owner.equals(program) ?? false;
