// Vault derivation and Spend construction. Mirrors client/qc.ts spendIxs exactly,
// except that the Ed25519 owner is an external wallet (passed as a public key).
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Buffer } from "buffer";
import { SEED_LEN, MASTER_LEN, concat, equal, publicKeyHash, recoverPkHash, sha, sign, spendDigest, toHex, u64le } from "./wots";

export interface VaultSecret { master: Uint8Array; seed: Uint8Array }

export function generateSecret(): VaultSecret {
  const master = new Uint8Array(MASTER_LEN), seed = new Uint8Array(SEED_LEN);
  crypto.getRandomValues(master);
  crypto.getRandomValues(seed);
  return { master, seed };
}

export function vaultAddress(program: PublicKey, s: VaultSecret, owner: PublicKey): [PublicKey, number, Uint8Array] {
  const pk = publicKeyHash(s.master, s.seed);
  const [pda, bump] = PublicKey.findProgramAddressSync([Buffer.from("qcv"), Buffer.from(pk), owner.toBuffer()], program);
  return [pda, bump, pk];
}

export const tokenAccountOf = (mint: PublicKey, owner: PublicKey) =>
  getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);

/** The program rejects duplicate accounts and here owner == wallet, so the closed
 *  token account's rent cannot go to the wallet directly. It goes to a collector key
 *  derived from the (backed up) WOTS master and is swept back to the wallet after. */
export function rentCollector(s: VaultSecret): Keypair {
  return Keypair.fromSeed(sha(new TextEncoder().encode("QSAFE/rent"), s.master));
}

export interface SpendPlan {
  pda: PublicKey; bump: number; vaultTa: PublicKey; digest: Uint8Array; digestHex: string;
  dest: PublicKey; refund: PublicKey; rentTo: PublicKey; amount: bigint;
}

export function planSpend(program: PublicKey, mint: PublicKey, s: VaultSecret, owner: PublicKey,
  dest: PublicKey, refund: PublicKey, rentTo: PublicKey, amount: bigint): SpendPlan {
  const [pda, bump] = vaultAddress(program, s, owner);
  const vaultTa = tokenAccountOf(mint, pda);
  const keys = [pda, vaultTa, mint, dest, refund, rentTo, TOKEN_2022_PROGRAM_ID, owner].map((k) => k.toBase58());
  if (new Set(keys).size !== keys.length) throw new Error("spend accounts must all be distinct (program error 6)");
  const digest = spendDigest(program.toBytes(), pda.toBytes(), mint.toBytes(), dest.toBytes(),
    refund.toBytes(), rentTo.toBytes(), amount);
  return { pda, bump, vaultTa, digest, digestHex: toHex(digest), dest, refund, rentTo, amount };
}

/** Builds [ComputeBudget 1.4M, Spend]. Caller MUST have persisted plan.digestHex first. */
export function spendIxs(program: PublicKey, mint: PublicKey, s: VaultSecret, owner: PublicKey, p: SpendPlan): TransactionInstruction[] {
  const sig = sign(s.master, s.seed, p.digest);
  const [, , pk] = vaultAddress(program, s, owner);
  if (!equal(recoverPkHash(s.seed, p.digest, sig), pk)) throw new Error("WOTS self-check failed");
  const data = concat(Uint8Array.of(0, p.bump), s.seed, u64le(p.amount), sig);
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    new TransactionInstruction({
      programId: program, data: Buffer.from(data),
      keys: [
        { pubkey: p.pda, isSigner: false, isWritable: false },
        { pubkey: p.vaultTa, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: p.dest, isSigner: false, isWritable: true },
        { pubkey: p.refund, isSigner: false, isWritable: true },
        { pubkey: p.rentTo, isSigner: false, isWritable: true },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: owner, isSigner: true, isWritable: false },
      ],
    }),
  ];
}

export const createAtaIx = (payer: PublicKey, ata: PublicKey, owner: PublicKey, mint: PublicKey) =>
  createAssociatedTokenAccountIdempotentInstruction(payer, ata, owner, mint, TOKEN_2022_PROGRAM_ID);

/** Deposit: create the vault ATA idempotently, then transferChecked from the wallet ATA. */
export function depositIxs(mint: PublicKey, decimals: number, wallet: PublicKey, vaultPda: PublicKey, amount: bigint) {
  const vaultTa = tokenAccountOf(mint, vaultPda);
  return [
    createAtaIx(wallet, vaultTa, vaultPda, mint),
    createTransferCheckedInstruction(tokenAccountOf(mint, wallet), mint, vaultTa, wallet, amount, decimals, [], TOKEN_2022_PROGRAM_ID),
  ];
}

/** Collector pays its own fee and sends the rest to `to` (leaves it at 0 lamports). */
export function sweepIx(collector: PublicKey, to: PublicKey, balance: number, fee = 5000) {
  const lamports = balance - fee;
  return lamports > 0 ? SystemProgram.transfer({ fromPubkey: collector, toPubkey: to, lamports }) : null;
}

export function parseAmount(s: string, decimals: number): bigint {
  const m = s.trim().match(/^(\d+)(?:\.(\d*))?$/);
  if (!m) throw new Error("invalid amount");
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new Error(`max ${decimals} decimals`);
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

export function formatAmount(v: bigint, decimals: number): string {
  const s = v.toString().padStart(decimals + 1, "0");
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return s.slice(0, -decimals) + (frac ? "." + frac : "");
}
