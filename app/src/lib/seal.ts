// Password encryption for vault secrets: PBKDF2-SHA256 (600k) -> AES-256-GCM.
import { fromHex, toHex } from "./wots";

export const PBKDF2_ITERATIONS = 600_000;

export interface EncBlob { kdf: "PBKDF2-SHA256"; iter: number; salt: string; iv: string; ct: string }

/** Secret payload. `signed`/`used` are kept inside too so a backup alone enforces the one-time rule. */
export interface SecretPayload { master: string; seed: string; signed?: string; used: boolean }

const te = new TextEncoder();
const buf = (u: Uint8Array) => u as Uint8Array<ArrayBuffer>;

async function deriveKey(password: string, salt: Uint8Array, iter: number) {
  const base = await crypto.subtle.importKey("raw", te.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: buf(salt), iterations: iter },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** `aad` binds the ciphertext to the vault's public identity (owner + PDA). */
export async function seal(p: SecretPayload, password: string, aad: string): Promise<EncBlob> {
  if (password.length < 10) throw new Error("password must be at least 10 characters");
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(aad) }, key, te.encode(JSON.stringify(p)));
  return { kdf: "PBKDF2-SHA256", iter: PBKDF2_ITERATIONS, salt: toHex(salt), iv: toHex(iv), ct: toHex(new Uint8Array(ct)) };
}

export async function unseal(b: EncBlob, password: string, aad: string): Promise<SecretPayload> {
  if (b.kdf !== "PBKDF2-SHA256" || b.iter < PBKDF2_ITERATIONS) throw new Error("unsupported backup format");
  const key = await deriveKey(password, fromHex(b.salt), b.iter);
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(fromHex(b.iv)), additionalData: te.encode(aad) },
      key, buf(fromHex(b.ct)));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch {
    throw new Error("wrong password (or the backup file was modified)");
  }
}
