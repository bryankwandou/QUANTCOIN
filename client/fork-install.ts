// Surfpool only: swap the program's bytes on a mainnet fork for SO, and set the
// fork's Rent sysvar to mainnet's (5,080 lamports/byte-year, threshold 2.0), so
// surfpool-suite.ts runs against the binary an upgrade would deploy.
// Env: SURF_RPC (default http://127.0.0.1:8899), PROGRAM_ID, SO.
import { Connection, PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const RPC = process.env.SURF_RPC ?? "http://127.0.0.1:8899";
const conn = new Connection(RPC, "confirmed");
const program = new PublicKey(process.env.PROGRAM_ID!);
const so = readFileSync(process.env.SO!);
const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const [pd] = PublicKey.findProgramAddressSync([program.toBuffer()], LOADER);

async function rpc(method: string, params: unknown[]) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then(x => x.json());
  if (r.error) throw new Error(`${method}: ${JSON.stringify(r.error)}`);
  return r.result;
}

const cur = await conn.getAccountInfo(pd);
if (!cur) throw new Error("program data not found on fork");
// AUTH=<pubkey>: keep the deployed bytes and only hand the fork's upgrade authority
// to a throwaway key, so a real `solana program extend/deploy` (which refreshes the
// runtime's program cache, unlike a raw byte swap) can follow.
const data = process.env.AUTH ? Buffer.from(cur.data) : Buffer.concat([cur.data.subarray(0, 45), so]);
if (process.env.AUTH) new PublicKey(process.env.AUTH).toBuffer().copy(data, 13);
const lamports = await conn.getMinimumBalanceForRentExemption(data.length);
await rpc("surfnet_setAccount", [pd.toBase58(), { lamports, data: data.toString("hex"),
  owner: LOADER.toBase58(), executable: false }]);

const rent = Buffer.alloc(17);
rent.writeBigUInt64LE(5080n, 0);
rent.writeDoubleLE(2.0, 8);
rent[16] = 50;
await rpc("surfnet_setAccount", ["SysvarRent111111111111111111111111111111111",
  { data: rent.toString("hex") }]);

const after = await conn.getAccountInfo(pd);
console.log({ programData: pd.toBase58(), soSha256: createHash("sha256").update(so).digest("hex"),
  installedSha256: createHash("sha256").update(after!.data.subarray(45, 45 + so.length)).digest("hex") });
