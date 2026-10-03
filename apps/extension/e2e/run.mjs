// Loads dist/ into Edge and drives the popup page.
process.on("uncaughtException", (e) => { if (e?.name !== "TargetClosedError") throw e; });
//   node e2e/run.mjs            -> mainnet read + owner/vault create, seal/unseal, import
//   SURFPOOL=http://127.0.0.1:8899 node e2e/run.mjs   -> also a full withdraw on that fork
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("../../node_modules/playwright");
const EXT = resolve("dist");
const ID = "nbchhoognfblfokeiknmgbjghembmona";   // fixed by manifest "key"
const PW = "e2e password 1234";
const SURF = process.env.SURFPOOL;
const READ_RPC = process.env.READ_RPC;   // e.g. local copy of the patched site proxy
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m); } };

const profile = mkdtempSync(join(tmpdir(), "qsafe-e2e-"));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "msedge", headless: false, acceptDownloads: true,
  args: ["--headless=new", `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
try {
  const page = await ctx.newPage();
  const downloads = [];
  page.on("download", async (d) => downloads.push(await (await d.createReadStream()).toArray().then((c) => Buffer.concat(c).toString())));
  await page.goto(`chrome-extension://${ID}/popup.html`);
  await page.getByTestId("rpc").filter({ hasNotText: "connecting" }).waitFor({ timeout: 30000 });
  let rpcText = await page.getByTestId("rpc").innerText();
  console.log(rpcText);

  // 1. real mainnet balance
  if (READ_RPC) { await page.getByTestId("rpc-input").fill(READ_RPC); await page.getByTestId("rpc-save").click();
    await page.getByTestId("rpc").filter({ hasText: READ_RPC }).waitFor({ timeout: 30000 }); rpcText = await page.getByTestId("rpc").innerText(); console.log(rpcText); }
  if (!/unavailable/.test(rpcText)) {
    await page.getByTestId("lookup").fill("CrZm5SGo6G9HEQaqmHxB9KPH2W4vnxZMqYrfzGCb9x4G");
    await page.getByTestId("lookup-go").click();
    const amt = await page.getByTestId("lookup-amount").innerText({ timeout: 30000 }).catch(() => page.getByTestId("err").innerText());
    ok(amt === "4,378,000,000,000", `mainnet balance of CrZm5SGo... = ${amt}`);
  } else ok(false, "mainnet balance (no RPC reachable from the extension)");

  // 2. owner key + vault, sealed in chrome.storage.local
  await page.getByTestId("pw").fill(PW);
  await page.getByTestId("pw2").fill(PW);
  await page.getByTestId("create-owner").click();
  const owner = await page.getByTestId("owner").innerText({ timeout: 60000 });
  await page.getByTestId("create-vault").click();
  const vaultId = await page.getByTestId("vault-id").first().innerText({ timeout: 60000 });
  ok(owner.length >= 32 && vaultId.length >= 32, `owner ${owner} and vault ${vaultId} created`);
  const stored = await page.evaluate(() => chrome.storage.local.get(null));
  const vaults = JSON.parse(stored["quantum-safe/vaults/v1"]);
  const ownerRec = JSON.parse(stored["quantum-safe/owner/v1"]);
  ok(vaults[0].enc.iter === 600000 && vaults[0].enc.kdf === "PBKDF2-SHA256" && !("master" in vaults[0]), "vault stored sealed (PBKDF2 600k + AES-GCM)");
  ok(ownerRec.pubkey === owner && ownerRec.enc.ct.length > 128 && !("secretKey" in ownerRec), "owner key stored sealed");
  console.log(`download events seen: ${downloads.length}`);
  const vaultBackup = JSON.stringify(vaults[0], null, 1);   // == app backupJson(record)

  // 3. unseal in the page with app's seal.ts parameters via WebCrypto; wrong password fails
  const unsealIn = (pw) => page.evaluate(async ([blob, pw, aad]) => {
    const h = (s) => Uint8Array.from(s.match(/../g).map((x) => parseInt(x, 16)));
    const te = new TextEncoder();
    const base = await crypto.subtle.importKey("raw", te.encode(pw), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: h(blob.salt), iterations: blob.iter }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    try { return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: h(blob.iv), additionalData: te.encode(aad) }, key, h(blob.ct)))); } catch { return null; }
  }, [vaults[0].enc, pw, `quantum-safe|${owner}|${vaultId}`]);
  const p = await unsealIn(PW);
  ok(p && p.master.length === 64 && p.seed.length === 32 && p.used === false, "vault unseals with the right password");
  ok((await unsealIn("wrong password!!")) === null, "vault refuses a wrong password");

  // 4. import the downloaded vault backup in a fresh profile state (clear vaults, re-import)
  await page.evaluate(() => chrome.storage.local.remove("quantum-safe/vaults/v1"));
  await page.reload();
  await page.getByTestId("owner").waitFor();
  await page.getByTestId("pw").fill("wrong password!!");
  await page.getByTestId("paste").fill(vaultBackup);
  await page.getByTestId("import").click();
  ok(/wrong password/.test(await page.getByTestId("err").innerText({ timeout: 60000 })), "import with wrong password refused");
  await page.getByTestId("pw").fill(PW);
  await page.getByTestId("import").click();
  ok((await page.getByTestId("vault-id").first().innerText({ timeout: 60000 })) === vaultId, "vault backup re-imported");

  // 5. spend on a local fork
  if (SURF) {
    const rpc = async (method, params) => (await (await fetch(SURF, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json());
    await page.getByTestId("rpc-input").fill(SURF);
    await page.getByTestId("rpc-save").click();
    await page.getByTestId("rpc").filter({ hasText: SURF }).waitFor({ timeout: 30000 });
    const air = await rpc("requestAirdrop", [owner, 2_000_000_000]);
    ok(!air.error, `fork airdrop to owner ${JSON.stringify(air.error ?? "")}`);
    const ata = await page.getByTestId("vault-ata").first().innerText();
    const set = await rpc("surfnet_setTokenAccount", [vaultId, "AsEEaydVYMpghdNTrQoVZTAhJSewZT5xD9WE9hpA68W2",
      { amount: 1_000_000_000 }, "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);
    ok(!set.error, `fork: vault token account ${ata} funded with 10,000 QC ${JSON.stringify(set.error ?? "")}`);
    await page.reload();
    await page.getByTestId("pw").fill(PW);
    await page.getByTestId("vault-bal").filter({ hasText: "10,000" }).waitFor({ timeout: 60000 });
    await page.getByTestId("wd-amount").fill("1234.5");
    await page.getByTestId("wd-go").click();
    await page.getByTestId("log").filter({ hasText: /Done\.|Error/ }).waitFor({ timeout: 240000 });
    const log = await page.getByTestId("log").innerText();
    console.log(log);
    ok(/Done\. Remainder is in new vault/.test(log), "withdraw completed on fork");
    const after = JSON.parse((await page.evaluate(() => chrome.storage.local.get("quantum-safe/vaults/v1")))["quantum-safe/vaults/v1"]);
    const old = after.find((v) => v.id === vaultId);
    ok(old.status === "spent" && /^[0-9a-f]{48}$/.test(old.signed), "old vault spent with its signed digest persisted");
    const next = after.find((v) => v.id === old.pending.nextId);
    const b = async (a) => (await rpc("getTokenAccountBalance", [a])).result?.value.amount;
    ok(await b(old.pending.dest) === "123450000", `owner received 1,234.5 QC on the fork`);
    ok(await b(next.ata) === "876550000", "remainder 8,765.5 QC in the next vault");
  }
} catch (e) {
  fail++; console.log("FAIL exception:", e.message);
} finally {
  process.on("unhandledRejection", () => {}); await ctx.close().catch(() => {});
  rmSync(profile, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
