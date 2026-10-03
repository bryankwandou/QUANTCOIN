// Extension-only code on top of app/'s libs (app/test/*.test.ts also run in this suite).
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { flush, hydrate, syncStorage } from "../src/storage";
import { createOwner, getOwner, importOwner, parseOwnerBackup, unsealOwner, sealOwner } from "../src/owner";
import { createVault, getVault, openVault, recordSigned, useStorage } from "@app/store";
import { PROGRAM_ID, QC_MINT } from "@app/config";

const disk = new Map<string, unknown>();
let failNext = false;
const kv = {
  get: async (ks: string[]) => Object.fromEntries(ks.filter((k) => disk.has(k)).map((k) => [k, disk.get(k)])),
  set: async (o: Record<string, unknown>) => { if (failNext) { failNext = false; throw new Error("quota"); } for (const [k, v] of Object.entries(o)) disk.set(k, v); },
};
const PW = "correct horse battery";

describe("extension storage + owner key", () => {
  it("write-through: vault records reach the backing store, sealed only", async () => {
    await hydrate(kv, ["quantum-safe/vaults/v1", "quantum-safe/owner/v1"]);
    useStorage(syncStorage);
    const owner = await createOwner(PW);
    const { record, secret } = await createVault(PROGRAM_ID, QC_MINT, Keypair.generate().publicKey, PW);
    await flush();
    const raw = String(disk.get("quantum-safe/vaults/v1")) + String(disk.get("quantum-safe/owner/v1"));
    expect(raw).toContain(record.id);
    expect(raw).toContain(owner.pubkey);
    expect(raw).not.toContain(Buffer.from(secret.master).toString("hex"));
    const kp = await unsealOwner(getOwner()!, PW);
    expect(raw).not.toContain(Buffer.from(kp.secretKey).toString("hex"));
  });

  it("signed digest is on disk after flush (persisted before broadcast)", async () => {
    const { record } = await createVault(PROGRAM_ID, QC_MINT, Keypair.generate().publicKey, PW);
    const { payload } = await openVault(record, PW);
    const d = "ab".repeat(24);
    await recordSigned(record, payload, PW, { amount: "1", dest: "d", refund: "r", rentTo: "t", nextId: "n", digest: d });
    await flush();
    const onDisk = JSON.parse(String(disk.get("quantum-safe/vaults/v1"))).find((v: { id: string }) => v.id === record.id);
    expect(onDisk.signed).toBe(d);
    await expect(recordSigned(getVault(record.id)!, payload, PW, { amount: "2", dest: "d", refund: "r", rentTo: "t", nextId: "n", digest: "cd".repeat(24) })).rejects.toThrow(/one-time/);
  });

  it("flush throws if a write failed, so the spend path refuses to broadcast", async () => {
    failNext = true;
    syncStorage.setItem("x", "y");
    await expect(flush()).rejects.toThrow(/could not save/);
  });

  it("owner backup: wrong password, tamper and mismatched-owner import are refused", async () => {
    const r = await sealOwner(Keypair.generate(), PW);
    const parsed = parseOwnerBackup(JSON.stringify(r));
    await expect(unsealOwner(parsed, "wrong password!!")).rejects.toThrow(/wrong password/);
    await expect(unsealOwner({ ...parsed, pubkey: Keypair.generate().publicKey.toBase58() }, PW)).rejects.toThrow(/wrong password/);
    await expect(importOwner(parsed, PW)).rejects.toThrow(/different owner/);
    expect(() => parseOwnerBackup("{}")).toThrow(/not a Quantum Safe/);
    expect(r.enc.iter).toBe(600_000);
  });
});
