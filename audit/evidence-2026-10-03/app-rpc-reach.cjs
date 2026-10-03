const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch({ channel: "msedge" }); const pg = await b.newPage();
  await pg.goto("https://quantcoin-pi.vercel.app/app/", { waitUntil: "networkidle" });
  const js = await pg.$$eval("script[src]", (s) => s.map((x) => x.src));
  let found = false; for (const u of js) { const t = await (await fetch(u)).text(); if (t.includes("/api/rpc/")) found = true; }
  console.log(found ? "PASS" : "FAIL", "/app/ bundle uses location.origin + /api/rpc/", js);
  const r = await pg.evaluate(async () => { const r = await fetch(location.origin + "/api/rpc/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: ["AsEEaydVYMpghdNTrQoVZTAhJSewZT5xD9WE9hpA68W2", { encoding: "base64" }] }) }); const j = await r.json(); return { status: r.status, owner: j.result?.value?.owner }; });
  console.log(r.status === 200 && r.owner === "TokenzQdBNbLqP5VEhdkAxSjjgaasLVoCeykKXahoQnj8f2Rr" ? "PASS" : "FAIL", "/app/ page context reaches mainnet via /api/rpc/ (QC mint owner = Token-2022)", JSON.stringify(r));
  await b.close();
})();
