// Vault records (public fields + encrypted secrets). localStorage in the browser;
// the node round-trip script plugs in an in-memory Storage.
import { PublicKey } from "@solana/web3.js";
import { EncBlob, SecretPayload, seal, unseal } from "./seal";
import { VaultSecret, generateSecret, tokenAccountOf, vaultAddress } from "./vault";
import { fromHex, toHex } from "./wots";

export interface PendingSpend { amount: string; dest: string; refund: string; rentTo: string; nextId: string; digest: string }

export interface VaultRecord {
  format: "quantum-safe-vault/1";
  id: string;             // = vault PDA (base58)
  owner: string; program: string; mint: string; ata: string;
  created: number;
  backedUp: boolean;      // backup file downloaded; required before showing as deposit address
  status: "active" | "spent";
  signed?: string;        // public copy of the one digest this key ever signed
  pending?: PendingSpend; // parameters of that signed spend, for identical retries
  enc: EncBlob;
}

const KEY = "quantum-safe/vaults/v1";
let storage: Pick<Storage, "getItem" | "setItem"> = globalThis.localStorage;
export const useStorage = (s: Pick<Storage, "getItem" | "setItem">) => { storage = s; };

export const aadOf = (r: Pick<VaultRecord, "owner" | "id">) => `quantum-safe|${r.owner}|${r.id}`;

export function listVaults(): VaultRecord[] {
  try { return JSON.parse(storage.getItem(KEY) ?? "[]"); } catch { return []; }
}

export function putVault(r: VaultRecord) {
  const all = listVaults().filter((v) => v.id !== r.id);
  all.push(r);
  storage.setItem(KEY, JSON.stringify(all));
}

export const getVault = (id: string) => listVaults().find((v) => v.id === id);

export async function createVault(program: PublicKey, mint: PublicKey, owner: PublicKey, password: string):
  Promise<{ record: VaultRecord; secret: VaultSecret }> {
  const secret = generateSecret();
  const [pda] = vaultAddress(program, secret, owner);
  const base = { id: pda.toBase58(), owner: owner.toBase58() };
  const enc = await seal({ master: toHex(secret.master), seed: toHex(secret.seed), used: false }, password, aadOf(base));
  const record: VaultRecord = {
    format: "quantum-safe-vault/1", ...base, program: program.toBase58(), mint: mint.toBase58(),
    ata: tokenAccountOf(mint, pda).toBase58(), created: Date.now(), backedUp: false, status: "active", enc,
  };
  putVault(record);
  return { record, secret };
}

export async function openVault(r: VaultRecord, password: string): Promise<{ secret: VaultSecret; payload: SecretPayload }> {
  const payload = await unseal(r.enc, password, aadOf(r));
  const secret = { master: fromHex(payload.master), seed: fromHex(payload.seed) };
  const [pda] = vaultAddress(new PublicKey(r.program), secret, new PublicKey(r.owner));
  if (pda.toBase58() !== r.id) throw new Error("backup does not match this vault address");
  return { secret, payload };
}

/** Persist the signed digest (public field AND inside the encrypted payload) BEFORE broadcasting. */
export async function recordSigned(r: VaultRecord, payload: SecretPayload, password: string, pending: PendingSpend) {
  const signed = pending.digest;
  const prior = r.signed ?? payload.signed;
  if (prior && prior !== signed) throw new Error("this vault already signed a different spend; WOTS keys are one-time");
  if (!prior && payload.used) throw new Error("this vault key is marked used");
  const enc = await seal({ ...payload, signed, used: true }, password, aadOf(r));
  const next: VaultRecord = { ...r, signed, pending, enc };
  putVault(next);
  return next;
}

export function backupJson(r: VaultRecord) {
  return JSON.stringify(r, null, 1);
}

/** Validates the structure only; the password check happens in openVault. */
export function parseBackup(text: string): VaultRecord {
  const r = JSON.parse(text) as VaultRecord;
  if (r.format !== "quantum-safe-vault/1" || !r.id || !r.owner || !r.enc?.ct) throw new Error("not a Quantum Safe backup file");
  new PublicKey(r.id); new PublicKey(r.owner);
  return r;
}

/** Merge an imported record without ever un-spending or forgetting a signed digest. */
export function importRecord(r: VaultRecord) {
  const cur = getVault(r.id);
  if (cur?.signed && r.signed && cur.signed !== r.signed) throw new Error("conflicting signed digests; refusing import");
  putVault({
    ...r, backedUp: true,
    status: cur?.status === "spent" ? "spent" : r.status,
    signed: cur?.signed ?? r.signed, pending: cur?.pending ?? r.pending,
    enc: cur?.signed && !r.signed ? cur.enc : r.enc,
  });
}
