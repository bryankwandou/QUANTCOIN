// Serves web/api/rpc.mjs (the real handler, upstream = public mainnet) on :8899 so the e2e
// test exercises the patched ORIGIN_OK before the site is redeployed.
import http from "node:http";
import handler from "../../../web/api/rpc.mjs";
http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  req.body = body;
  const r = { status(c) { res.statusCode = c; return r; }, setHeader(k, v) { res.setHeader(k, v); return r; },
    json(o) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); }, send(t) { res.end(t); }, end() { res.end(); } };
  await handler(req, r);
}).listen(8899, "127.0.0.1", () => console.log("proxy on 8899"));
