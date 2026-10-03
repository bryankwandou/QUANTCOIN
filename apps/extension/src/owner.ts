// The web app signs as the vault owner through a wallet adapter (Phantom/Solflare).
// Wallet adapters inject into web pages and cannot reach an extension popup, so the
// extension keeps its own Ed25519 owner key, sealed with app/'s seal.ts
// (PBKDF2-SHA256 600k -> AES-256-GCM). The plaintext key only exists in memory while a
// password-gated action runs. It is the vault owner AND the fee payer: fund it with SOL.
import { Keypair, PublicKey } from "@solana/web3.js";
import { EncBlob, seal, unseal } from "@app/seal";
import { fromHex, toHex } from "@app/wots";
import { syncStorage } from "./storage";

export const OWNER_KEY = "quantum-safe/owner/v1";
export interface OwnerRecord { format: "quantum-safe-owner/1"; pubkey: string; enc: EncBlob }
const aad = (pub: string) => `quantum-safe-owner|${pub}`;

export function getOwner(): OwnerRecord | null {
  try { return JSON.parse(syncStorage.getItem(OWNER_KEY) ?? "null"); } catch { return null; }
}

export async function sealOwner(kp: Keypair, password: string): Promise<OwnerRecord> {
  const pubkey = kp.publicKey.toBase58();
  // seal() takes app's SecretPayload; the 64-byte secret key goes in `master`.
  const enc = await seal({ master: toHex(kp.secretKey), seed: "", used: false }, password, aad(pubkey));
  return { format: "quantum-safe-owner/1", pubkey, enc };
}

export async function createOwner(password: string): Promise<OwnerRecord> {
  if (getOwner()) throw new Error("an owner key already exists; export it before replacing");
  const r = await sealOwner(Keypair.generate(), password);   // randomness: crypto.getRandomValues
  syncStorage.setItem(OWNER_KEY, JSON.stringify(r));
  return r;
}

export async function unsealOwner(r: OwnerRecord, password: string): Promise<Keypair> {
  const p = await unseal(r.enc, password, aad(r.pubkey));
  const kp = Keypair.fromSecretKey(fromHex(p.master));
  if (kp.publicKey.toBase58() !== r.pubkey) throw new Error("owner backup does not match its public key");
  return kp;
}

export function parseOwnerBackup(text: string): OwnerRecord {
  const r = JSON.parse(text) as OwnerRecord;
  if (r?.format !== "quantum-safe-owner/1" || typeof r.enc?.ct !== "string") throw new Error("not a Quantum Safe owner backup");
  new PublicKey(r.pubkey);
  return r;
}

export async function importOwner(r: OwnerRecord, password: string) {
  const cur = getOwner();
  if (cur && cur.pubkey !== r.pubkey) throw new Error("a different owner key is already stored");
  await unsealOwner(r, password);   // proves the password before storing
  syncStorage.setItem(OWNER_KEY, JSON.stringify(r));
}
