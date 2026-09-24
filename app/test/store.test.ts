import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { createVault, openVault, recordSigned, useStorage, parseBackup, backupJson, importRecord, getVault } from "../src/lib/store";
import { PROGRAM_ID, QC_MINT } from "../src/lib/config";

const mem = new Map<string, string>();
useStorage({ getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) });

describe("encrypted vault store", () => {
  it("round-trips, rejects a wrong password, enforces the one-time digest", async () => {
    const owner = Keypair.generate().publicKey;
    const { record, secret } = await createVault(PROGRAM_ID, QC_MINT, owner, "correct horse battery");
    expect(record.enc.iter).toBeGreaterThanOrEqual(600_000);
    const { secret: s2, payload } = await openVault(parseBackup(backupJson(record)), "correct horse battery");
    expect(Buffer.from(s2.master).equals(Buffer.from(secret.master))).toBe(true);
    expect(s2.seed.length).toBe(16);
    await expect(openVault(record, "wrong password!!")).rejects.toThrow(/wrong password/);

    const p = { amount: "1", dest: "d", refund: "r", rentTo: "t", nextId: "n", digest: "aa".repeat(24) };
    const r2 = await recordSigned(record, payload, "correct horse battery", p);
    expect(r2.signed).toBe(p.digest);
    const again = await openVault(r2, "correct horse battery");
    expect(again.payload.signed).toBe(p.digest);
    await recordSigned(r2, again.payload, "correct horse battery", p); // identical retry OK
    await expect(recordSigned(r2, again.payload, "correct horse battery", { ...p, digest: "bb".repeat(24) })).rejects.toThrow(/one-time/);
    // Importing an older backup must not drop the signed digest.
    importRecord(record);
    expect(getVault(record.id)?.signed).toBe(p.digest);
  }, 60_000);
});
