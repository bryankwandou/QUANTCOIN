const { chromium } = require("playwright");
const BASE = "https://quantcoin-pi.vercel.app";
let pass = 0, fail = 0; const ok = (n, c, d) => { c ? pass++ : fail++; console.log(c ? "PASS" : "FAIL", n, d === undefined ? "" : JSON.stringify(d)); };
(async () => {
  const b = await chromium.launch({ channel: "msedge" });
  for (const p of ["/", "/id/", "/whitepaper/", "/launch/", "/audit/", "/transparency/", "/app/"]) {
    const pg = await b.newPage(); const errs = []; const rpc = [];
    pg.on("console", (m) => m.type() === "error" && errs.push(m.text().slice(0, 200)));
    pg.on("pageerror", (e) => errs.push("pageerror " + String(e).slice(0, 200)));
    pg.on("response", (r) => r.url().includes("/api/rpc") && rpc.push(r.status()));
    const res = await pg.goto(BASE + p, { waitUntil: "networkidle", timeout: 90000 }).catch((e) => null);
    await pg.waitForTimeout(p === "/transparency/" || p === "/app/" ? 15000 : 3000);
    ok(`${p} HTTP 200`, res && res.status() === 200, res && res.status());
    ok(`${p} no console errors`, errs.length === 0, errs);
    if (p === "/transparency/") {
      const t = await pg.innerText("body");
      ok("/transparency/ shows real balances (7,699,999,999,999 treasury / 4,378,000,000,000 liquidity)", /7,699,999,999,999|7\.699/.test(t) && /4,378,000,000,000|4\.378/.test(t), t.match(/[\d,]{9,}/g)?.slice(0, 12));
      ok("/transparency/ reached /api/rpc with 200", rpc.length > 0 && rpc.every((s) => s === 200), rpc.slice(0, 10));
    }
    if (p === "/app/") ok("/app/ reached mainnet via /api/rpc/ (all 200)", rpc.length > 0 && rpc.every((s) => s === 200), { calls: rpc.length, statuses: [...new Set(rpc)] });
    await pg.close();
  }
  await b.close();
  const post = (h, body) => fetch(BASE + "/api/rpc/", { method: "POST", headers: { "content-type": "application/json", ...h }, body });
  const gv = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getVersion" });
  let r = await post({ origin: BASE }, gv); ok("proxy: allowed origin -> 200", r.status === 200, r.status);
  r = await post({ origin: "https://evil.example" }, gv); ok("proxy: foreign origin -> 403", r.status === 403, r.status);
  r = await post({ origin: BASE }, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getProgramAccounts", params: [] })); ok("proxy: disallowed method rejected (400)", r.status === 400, [r.status, (await r.text()).slice(0, 120)]);
  r = await post({ origin: BASE }, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getVersion", params: ["x".repeat(70000)] })); ok("proxy: oversize body rejected (413)", r.status === 413, r.status);
  r = await post({ origin: BASE }, JSON.stringify(Array.from({ length: 21 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "getVersion" })))); ok("proxy: batch >20 rejected (400)", r.status === 400, r.status);
  r = await fetch(BASE + "/api/rpc/", { headers: { origin: BASE } }); ok("proxy: GET rejected (405)", r.status === 405, r.status);
  console.log(`TOTAL ${pass} pass / ${fail} fail`); process.exit(fail ? 1 : 0);
})();
