// Minimal stdio MCP client for the pen.dev desktop app.
// node pen.mjs --js file.js   -> execute(file contents)
// node pen.mjs calls.json     -> [[tool,args],...]
import { spawn } from "node:child_process";
import fs from "node:fs";
const exe = "C:/Users/arche/AppData/Local/Programs/Pen/resources/app.asar.unpacked/out/mcp-server-windows-x64.exe";
const p = spawn(exe, ["--app", "desktop", "--agent", "claudeCodeCLI"]);
let buf = "", id = 0; const wait = {};
p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); wait[m.id]?.(m); } catch {} } });
const rpc = (method, params) => new Promise((r) => { const i = ++id; wait[i] = r; p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); });
const t = setTimeout(() => { console.log("TIMEOUT"); process.exit(1); }, Number(process.env.T || 300000));
await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "cc", version: "1" } });
p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const a = process.argv[2];
const calls = a === "--js" ? [["execute", { input: fs.readFileSync(process.argv[3], "utf8") }]] : a ? JSON.parse(fs.readFileSync(a, "utf8")) : [["tools/list", {}]];
let k = 0;
for (const [m, args] of calls) {
  const r = m === "tools/list" ? await rpc(m, args) : await rpc("tools/call", { name: m, arguments: args });
  let out;
  if (r.result?.tools) out = r.result.tools.map((x) => x.name).join(", ");
  else out = (r.result?.content || []).map((c) => {
    if (c.type === "image") { const f = `shot-${k++}.png`; fs.writeFileSync(f, Buffer.from(c.data, "base64")); return "[image] " + f; }
    return c.type === "text" ? c.text : `[${c.type}]`;
  }).join("\n") || JSON.stringify(r.error);
  console.log(`=== ${m}\n${out}`);
}
clearTimeout(t); p.kill(); process.exit(0);
