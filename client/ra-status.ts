// Prints one line for the automation scripts: state of the proposal recorded under TAG,
// the chain clock, and when its time lock ends.  Env: TAG (QC_NET=mainnet implied).
import * as multisig from "@sqds/multisig";
import { Connection, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
const conn = new Connection(process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
const ms = new PublicKey(JSON.parse(readFileSync(new URL("./squads-mainnet.json", import.meta.url), "utf8")).multisig);
let s: any = {};
try { s = JSON.parse(readFileSync(new URL(`./upgrade-${process.env.TAG}.json`, import.meta.url), "utf8")); } catch {}
const now = (await conn.getBlockTime(await conn.getSlot())) ?? 0;
if (!s.transactionIndex) { console.log(`none now=${now}`); process.exit(0); }
const [p] = multisig.getProposalPda({ multisigPda: ms, transactionIndex: BigInt(s.transactionIndex) });
const a = await multisig.accounts.Proposal.fromAccountAddress(conn, p);
const ts = Number((a.status as any).timestamp ?? 0);
console.log(`${a.status.__kind} index=${s.transactionIndex} approvals=${a.approved.length} now=${now} release=${ts + 86400} buffer=${s.buffer ?? ""}`);
