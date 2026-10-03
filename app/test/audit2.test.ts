// AUDIT-2 regression tests for client-side key safety.
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createVault, openVault, recordSigned, useStorage, parseBackup, backupJson, importRecord, getVault } from "../src/lib/store";
import { seal, unseal } from "../src/lib/seal";
import { PROGRAM_ID, QC_MINT } from "../src/lib/config";

const mem = new Map<string, string>();
useStorage({ getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) });
const PW = "correct horse battery";
const pend = (digest: string) => ({ amount: "1", dest: "d", refund: "r", rentTo: "t", nextId: "n", digest });

describe("AUDIT-2 client fixes", () => {
  it("C-1: a stale in-memory record (second tab / old UI state) cannot sign a second digest", async () => {
    const owner = Keypair.generate().publicKey;
    const { record } = await createVault(PROGRAM_ID, QC_MINT, owner, PW);
    const stale = await openVault(record, PW);           // tab B opened the vault earlier
    const fresh = await openVault(record, PW);
    await recordSigned(record, fresh.payload, PW, pend("aa".repeat(24)));   // tab A signs
    // tab B still holds the pre-signing record + payload and tries another spend
    await expect(recordSigned(record, stale.payload, PW, pend("bb".repeat(24)))).rejects.toThrow(/one-time/);
    expect(getVault(record.id)?.signed).toBe("aa".repeat(24));
  }, 60_000);

  it("C-2: backup import rejects a tampered deposit address / program / mint", async () => {
    const owner = Keypair.generate().publicKey;
    const { record } = await createVault(PROGRAM_ID, QC_MINT, owner, PW);
    const evil = Keypair.generate().publicKey.toBase58();
    expect(() => parseBackup(JSON.stringify({ ...record, ata: evil }))).toThrow(/deposit address/);
    expect(() => parseBackup(JSON.stringify({ ...record, program: evil }))).toThrow(/program/);
    expect(() => parseBackup(JSON.stringify({ ...record, mint: evil }))).toThrow(/mint/);
    expect(() => parseBackup(JSON.stringify({ ...record, status: "weird" }))).toThrow();
    expect(parseBackup(backupJson(record)).id).toBe(record.id);
  }, 60_000);

  it("C-3: unseal refuses absurd KDF iteration counts (DoS via crafted backup)", async () => {
    const blob = await seal({ master: "00", seed: "00", used: false }, PW, "x");
    await expect(unseal({ ...blob, iter: 2_000_000_000 }, PW, "x")).rejects.toThrow(/unsupported/);
    expect((await unseal(blob, PW, "x")).used).toBe(false);
  }, 60_000);

  it("import never downgrades a signed vault even when the imported file is the older one", async () => {
    const owner = Keypair.generate().publicKey;
    const { record } = await createVault(PROGRAM_ID, QC_MINT, owner, PW);
    const { payload } = await openVault(record, PW);
    await recordSigned(record, payload, PW, pend("cc".repeat(24)));
    importRecord(parseBackup(backupJson(record)));
    const cur = getVault(record.id)!;
    expect(cur.signed).toBe("cc".repeat(24));
    expect((await openVault(cur, PW)).payload.signed).toBe("cc".repeat(24));
    new PublicKey(cur.ata);
  }, 60_000);
});
