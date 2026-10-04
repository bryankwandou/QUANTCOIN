// Live smoke test of https://quantcoin-pi.vercel.app, 2026-10-04. Read-only.
// Fixes F-1 of 2026-10-03: /app/ only calls the RPC after a wallet connects, so it is
// checked with an in-page call through /api/rpc/, and the Token-2022 id is now correct.
const { chromium } = require(process.env.PW ?? "playwright");
const BASE = "https://quantcoin-pi.vercel.app";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const REL = "https://github.com/bryankwandou/QUANTCOIN/releases/download/app-v0.1.0/";
let pass = 0, fail = 0; const ok = (n, c, d) => { c ? pass++ : fail++; console.log(c ? "PASS" : "FAIL", n, d === undefined ? "" : JSON.stringify(d)); };
(async () => {
  const b = await chromium.launch({ channel: "msedge" });
  for (const p of ["/", "/id/", "/whitepaper/", "/launch/", "/audit/", "/transparency/", "/app/"]) {
    const pg = await b.newPage(); const errs = []; const rpc = [];
    pg.on("console", (m) => m.type() === "error" && errs.push(m.text().slice(0, 200)));
    pg.on("pageerror", (e) => errs.push("pageerror " + String(e).slice(0, 200)));
    pg.on("response", (r) => r.url().includes("/api/rpc") && rpc.push(r.status()));
    const res = await pg.goto(BASE + p, { waitUntil: "networkidle", timeout: 90000 }).catch(() => null);
    await pg.waitForTimeout(p === "/transparency/" || p === "/app/" ? 15000 : 3000);
    ok(`${p} HTTP 200`, res && res.status() === 200, res && res.status());
    ok(`${p} no console errors`, errs.length === 0, errs);
    if (p === "/" || p === "/id/") {
      const html = await pg.content();
      ok(`${p} badge says Mainnet, not Devnet`, /Mainnet/.test(html) && !/>\s*Devnet\s*</i.test(html));
      const links = await pg.$$eval("#install a", (as) => as.map((a) => a.href));
      const want = ["QuantumSafe-android.apk", "QuantumSafe-extension.zip", "QuantumSafe-windows-x64.zip", "QuantumSafe-macos.zip", "QuantumSafe-ios-unsigned.ipa", "SHA256SUMS.txt"];
      ok(`${p} install section links all 6 release files`, want.every((f) => links.includes(REL + f)), links);
    }
    if (p === "/transparency/") {
      const t = await pg.innerText("body");
      ok("/transparency/ shows live balances (treasury 7,699,999,999,999 / liquidity 4,378,000,000,000)", /7,699,999,999,999|7\.699/.test(t) && /4,378,000,000,000|4\.378/.test(t));
      ok("/transparency/ reached /api/rpc with 200 only", rpc.length > 0 && rpc.every((s) => s === 200), { calls: rpc.length, statuses: [...new Set(rpc)] });
      const gov = await pg.innerText("#gov");
      ok("/transparency/ governance section: multisig, vault, 24h time lock, pool, position", /A9td/.test(gov) && /45nA/.test(gov) && /24 hours/.test(gov) && /AyS1/.test(gov) && /7Bqg/.test(gov));
    }
    if (p === "/app/") {
      ok("/app/ makes no RPC call before a wallet connects (by design)", rpc.length === 0, rpc.length);
      const r = await pg.evaluate(async () => { const r = await fetch(location.origin + "/api/rpc/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: ["AsEEaydVYMpghdNTrQoVZTAhJSewZT5xD9WE9hpA68W2", { encoding: "base64" }] }) }); const j = await r.json(); return { status: r.status, owner: j.result?.value?.owner }; });
      ok("/app/ page reaches mainnet through /api/rpc/ (QC mint owned by Token-2022)", r.status === 200 && r.owner === TOKEN_2022, r);
    }
    await pg.close();
  }
  await b.close();
  for (const f of ["QuantumSafe-android.apk", "QuantumSafe-extension.zip", "QuantumSafe-windows-x64.zip", "QuantumSafe-macos.zip", "QuantumSafe-ios-unsigned.ipa", "SHA256SUMS.txt"]) {
    const r = await fetch(REL + f, { method: "HEAD", redirect: "follow" }); ok(`download ${f} -> 200`, r.status === 200, [r.status, r.headers.get("content-length")]);
  }
  const post = (h, body) => fetch(BASE + "/api/rpc/", { method: "POST", headers: { "content-type": "application/json", ...h }, body });
  const gv = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getVersion" });
  let r = await post({ origin: BASE }, gv); ok("proxy: site origin -> 200", r.status === 200, r.status);
  r = await post({ origin: "chrome-extension://nbchhoognfblfokeiknmgbjghembmona" }, gv); ok("proxy: Quantum Safe extension origin -> 200", r.status === 200, r.status);
  r = await post({ origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, gv); ok("proxy: other extension origin -> 403", r.status === 403, r.status);
  r = await post({ origin: "https://evil.example" }, gv); ok("proxy: foreign site origin -> 403", r.status === 403, r.status);
  r = await post({ origin: BASE }, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getProgramAccounts", params: [] })); ok("proxy: disallowed method rejected (400)", r.status === 400, r.status);
  r = await post({ origin: BASE }, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getVersion", params: ["x".repeat(70000)] })); ok("proxy: oversize body rejected (413)", r.status === 413, r.status);
  r = await post({ origin: BASE }, JSON.stringify(Array.from({ length: 21 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "getVersion" })))); ok("proxy: batch >20 rejected (400)", r.status === 400, r.status);
  r = await fetch(BASE + "/api/rpc/", { headers: { origin: BASE } }); ok("proxy: GET rejected (405)", r.status === 405, r.status);
  console.log(`TOTAL ${pass} pass / ${fail} fail`); process.exit(fail ? 1 : 0);
})();
