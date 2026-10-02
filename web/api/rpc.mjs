// Mainnet RPC proxy for the static site. Public mainnet endpoints refuse
// browser requests (HTTP 403 when an Origin header is present), so the
// transparency page and Quantum Safe call this function instead. Only the
// read and send methods those pages use are forwarded; nothing here holds a key.
const UPSTREAM = process.env.MAINNET_RPC || "https://api.mainnet-beta.solana.com";
const ALLOWED = new Set([
  "getAccountInfo", "getMultipleAccounts", "getBalance", "getTokenAccountBalance", "getTokenSupply",
  "getLatestBlockhash", "isBlockhashValid", "getBlockHeight", "getSlot", "getBlockTime", "getEpochInfo",
  "getSignatureStatuses", "getSignaturesForAddress", "getTransaction", "getFeeForMessage",
  "getMinimumBalanceForRentExemption", "getRecentPrioritizationFees", "getVersion", "getGenesisHash",
  "sendTransaction", "simulateTransaction",
]);
const MAX_BATCH = 20, MAX_BYTES = 64 * 1024;

function check(body) {
  const items = Array.isArray(body) ? body : [body];
  if (!items.length || items.length > MAX_BATCH) return "batch size";
  for (const it of items) {
    if (!it || typeof it !== "object" || it.jsonrpc !== "2.0" || !ALLOWED.has(it.method)) return `method not allowed: ${it && it.method}`;
  }
  return null;
}

async function handler(req, res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type, solana-client");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  let body = req.body;
  if (typeof body === "string") {
    if (body.length > MAX_BYTES) return res.status(413).json({ error: "too large" });
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "bad json" }); }
  }
  const problem = check(body);
  if (problem) return res.status(400).json({ jsonrpc: "2.0", id: body && body.id, error: { code: -32601, message: problem } });
  const text = JSON.stringify(body);
  if (text.length > MAX_BYTES) return res.status(413).json({ error: "too large" });
  try {
    const r = await fetch(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body: text });
    res.status(r.status).setHeader("content-type", "application/json");
    return res.send(await r.text());
  } catch (e) {
    return res.status(502).json({ jsonrpc: "2.0", id: body && body.id, error: { code: -32000, message: "upstream unreachable" } });
  }
}

export default handler;
export { check };
