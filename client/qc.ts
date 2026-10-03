// Shared client code: WOTS (mirror of programs/qc-vault/src/wots.rs),
// vault derivation and the Spend instruction.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";

export const N = 24, MSG_DIGITS = 24, CHAINS = 26, SEED_LEN = 16;
const enc = (s: string) => Buffer.from(s, "ascii");
const D_CHAIN = enc("QCV1/chain"), D_PK = enc("QCV1/pk"), D_MSG = enc("QCV1/msg"), D_SK = enc("QCV1/sk");

const sha = (...parts: Uint8Array[]) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};

function chain(seed: Buffer, i: number, from: number, to: number, x: Buffer): Buffer {
  let v = x;
  for (let s = from; s < to; s++) v = sha(D_CHAIN, seed, Buffer.from([i, s]), v).subarray(0, N);
  return v;
}

export function digits(digest: Buffer): number[] {
  const d = [...digest.subarray(0, MSG_DIGITS)];
  const csum = d.reduce((a, x) => a + (255 - x), 0);
  return [...d, csum >> 8, csum & 0xff];
}

const secretChain = (master: Buffer, i: number) => sha(D_SK, master, Buffer.from([i])).subarray(0, N);

export function publicKeyHash(master: Buffer, seed: Buffer): Buffer {
  const ends = [];
  for (let i = 0; i < CHAINS; i++) ends.push(chain(seed, i, 0, 255, secretChain(master, i)));
  return sha(D_PK, seed, Buffer.concat(ends));
}

export function sign(master: Buffer, seed: Buffer, digest: Buffer): Buffer {
  const d = digits(digest);
  const out = [];
  for (let i = 0; i < CHAINS; i++) out.push(chain(seed, i, 0, d[i], secretChain(master, i)));
  return Buffer.concat(out);
}

export function spendDigest(program: PublicKey, vault: PublicKey, mint: PublicKey, dest: PublicKey,
  refund: PublicKey, rentTo: PublicKey, amount: bigint): Buffer {
  const a = Buffer.alloc(8); a.writeBigUInt64LE(amount);
  return sha(D_MSG, program.toBuffer(), vault.toBuffer(), mint.toBuffer(), dest.toBuffer(),
    refund.toBuffer(), rentTo.toBuffer(), a).subarray(0, MSG_DIGITS);
}

/** One hybrid vault = Ed25519 owner + one-time WOTS key. Both secrets must be backed up. */
export interface VaultKeys {
  name: string; owner: Keypair; master: Buffer; seed: Buffer; used: boolean;
  /** The one message this key signed (hex digest). Re-signing the SAME digest
   *  gives the identical signature, so a failed broadcast can be retried safely. */
  signed?: string;
}

export function vaultAddress(program: PublicKey, v: VaultKeys): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [enc("qcv"), publicKeyHash(v.master, v.seed), v.owner.publicKey.toBuffer()], program);
}

export const vaultTokenAccount = (program: PublicKey, mint: PublicKey, v: VaultKeys) =>
  getAssociatedTokenAddressSync(mint, vaultAddress(program, v)[0], true, TOKEN_2022_PROGRAM_ID);

// QC_NET=mainnet keeps mainnet secrets apart from the devnet ones in keys/.
export const NET = process.env.QC_NET ?? "devnet";
const KEYDIR = new URL(NET === "devnet" ? "./keys/" : `./keys-${NET}/`, import.meta.url);

export function newVault(name: string): VaultKeys {
  // Overwriting a key file loses whatever that vault holds.
  if (vaultExists(name)) throw new Error(`vault-${name}.json already exists in ${KEYDIR.pathname}; refusing to overwrite`);
  const v = { name, owner: Keypair.generate(), master: randomBytes(32), seed: randomBytes(SEED_LEN), used: false };
  saveVault(v);
  return v;
}

export function saveVault(v: VaultKeys) {
  mkdirSync(KEYDIR, { recursive: true });
  const file = new URL(`vault-${v.name}.json`, KEYDIR);
  writeFileSync(file, JSON.stringify({
    owner: [...v.owner.secretKey], master: v.master.toString("hex"), seed: v.seed.toString("hex"), used: v.used,
    signed: v.signed,
  }, null, 1));
}

export function loadVault(name: string): VaultKeys {
  const j = JSON.parse(readFileSync(new URL(`vault-${name}.json`, KEYDIR), "utf8"));
  return { name, owner: Keypair.fromSecretKey(Uint8Array.from(j.owner)),
    master: Buffer.from(j.master, "hex"), seed: Buffer.from(j.seed, "hex"), used: j.used, signed: j.signed };
}

export const vaultExists = (name: string) => existsSync(new URL(`vault-${name}.json`, KEYDIR));

/** Refuses a spend the program is certain to reject, BEFORE the one-time key
 *  signs it. A broadcast signature can never be followed by a different one,
 *  so a doomed transfer (too much, own vault, token account as recipient)
 *  would lock the vault for good. A retry of the recorded digest skips this. */
export async function checkSpend(conn: Connection, program: PublicKey, mint: PublicKey, v: VaultKeys,
  destOwner: PublicKey, amount: bigint) {
  if (v.signed) return;
  const [pda] = vaultAddress(program, v);
  if (amount <= 0n) throw new Error("amount must be above zero");
  if (destOwner.equals(pda)) throw new Error("recipient is this vault itself");
  if ((await conn.getAccountInfo(pda))?.owner.equals(program)) throw new Error(`vault ${v.name} is already spent`);
  const ta = await conn.getAccountInfo(vaultTokenAccount(program, mint, v));
  const held = ta?.owner.equals(TOKEN_2022_PROGRAM_ID) && ta.data.length >= 72 ? ta.data.readBigUInt64LE(64) : 0n;
  if (amount > held) throw new Error(`vault ${v.name} holds ${held} base units, asked to send ${amount}`);
  const o = (await conn.getAccountInfo(destOwner))?.owner;
  if (o && (o.equals(TOKEN_2022_PROGRAM_ID) || o.equals(TOKEN_PROGRAM_ID)))
    throw new Error("recipient is a token account or mint; pass the wallet address");
  if (o?.equals(program)) throw new Error("recipient is a spent vault; tokens sent there are locked forever");
  if ((o && DEAD_OWNERS.has(o.toBase58())) || destOwner.toBase58() === "1nc1nerator11111111111111111111111111111111")
    throw new Error("recipient is a program, sysvar or the incinerator; tokens sent there never move again");
}

/** Owners of accounts nobody can sign for. */
const DEAD_OWNERS = new Set([
  "BPFLoaderUpgradeab1e11111111111111111111111", "BPFLoader2111111111111111111111111111111111",
  "BPFLoader1111111111111111111111111111111111", "NativeLoader1111111111111111111111111111111",
  "LoaderV411111111111111111111111111111111111", "Sysvar1111111111111111111111111111111111111",
]);

export function spendIxs(program: PublicKey, mint: PublicKey, v: VaultKeys, dest: PublicKey,
  refund: PublicKey, rentTo: PublicKey, amount: bigint): TransactionInstruction[] {
  const [pda, bump] = vaultAddress(program, v);
  const ta = vaultTokenAccount(program, mint, v);
  const digest = spendDigest(program, pda, mint, dest, refund, rentTo, amount);
  // One-time rule: a key may only ever sign ONE digest. Retrying that same
  // digest is safe (identical signature); any other message is refused.
  if (v.signed ? v.signed !== digest.toString("hex") : v.used)
    throw new Error(`vault ${v.name} already signed a different message; WOTS keys are one-time`);
  if (!v.signed) { v.signed = digest.toString("hex"); v.used = true; saveVault(v); }
  const sig = sign(v.master, v.seed, digest);
  const a = Buffer.alloc(8); a.writeBigUInt64LE(amount);
  const data = Buffer.concat([Buffer.from([0, bump]), v.seed, a, sig]);
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    new TransactionInstruction({
      programId: program, data,
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: ta, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: dest, isSigner: false, isWritable: true },
        { pubkey: refund, isSigner: false, isWritable: true },
        { pubkey: rentTo, isSigner: false, isWritable: true },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: v.owner.publicKey, isSigner: true, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    }),
  ];
}

export function env() {
  const rpc = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.PAYER!, "utf8"))));
  const program = new PublicKey(process.env.PROGRAM_ID!);
  return { conn: new Connection(rpc, "confirmed"), payer, program };
}
