// Read-only mainnet check for the 2026-10-03 internal test pass. Signs nothing, sends nothing.
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getMint, getMetadataPointerState, getTokenMetadata, getExtensionTypes, ExtensionType, unpackAccount } from "@solana/spl-token";
import * as multisig from "@sqds/multisig";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import { readFileSync } from "node:fs";
const conn = new Connection(process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
const P = (s: string) => new PublicKey(s);
const MINT = P("AsEEaydVYMpghdNTrQoVZTAhJSewZT5xD9WE9hpA68W2"), PROGRAM = P("CiupyGrAtWomKW5rDWbaMEsm3Db8pY8NPECgL2FfACms");
const MS = P("A9tdTp68GVvGVLherFjDUgJptoHMWja5r4uWH5DFou2P"), SQV = "45nAvRrgqxkdnsDmW9dmukHNcxE1TM5PnJsH27cTXxez";
const POOL = P("AyS1vByiVFsVdsekRZE1mGVY5MHY1YMs59DeGwDwbbwB"), POS = P("7Bqgd7AyjAQw6LS9m7QHLTGiF851Net93fJdk8XSDWAt");
const pause = (ms = 2500) => new Promise((r) => setTimeout(r, ms));
async function retry<T>(f: () => Promise<T>): Promise<T> { for (let i = 0; ; i++) { try { await pause(); return await f(); } catch (e) { if (i >= 5) throw e; await pause(5000 * (i + 1)); } } }
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d?: unknown) => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", n, d === undefined ? "" : JSON.stringify(d)); };

// Program
const prog = (await retry(() => conn.getAccountInfo(PROGRAM)))!;
check("program executable, upgradeable loader", prog.executable && prog.owner.toBase58() === "BPFLoaderUpgradeab1e11111111111111111111111");
const pd = (await retry(() => conn.getAccountInfo(new PublicKey(prog.data.subarray(4, 36)))))!;
const auth = pd.data[12] === 1 ? new PublicKey(pd.data.subarray(13, 45)).toBase58() : null;
check("program upgrade authority = Squads vault 45nAv…", auth === SQV, auth);
// Multisig
const msi = (await retry(() => conn.getAccountInfo(MS)))!;
check("multisig owned by Squads v4", msi.owner.toBase58() === "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");
const [ms] = multisig.accounts.Multisig.fromAccountInfo(msi);
check("multisig threshold 2, 3 members", ms.threshold === 2 && ms.members.length === 3, { threshold: ms.threshold, members: ms.members.map((m) => m.key.toBase58()) });
check("multisig time lock 86400 s", ms.timeLock === 86400, ms.timeLock);
check("multisig config authority = none", ms.configAuthority.equals(PublicKey.default), ms.configAuthority.toBase58());
check("vault PDA index 0 derives to 45nAv…", multisig.getVaultPda({ multisigPda: MS, index: 0 })[0].toBase58() === SQV);
// Mint
const m = await retry(() => getMint(conn, MINT, "confirmed", TOKEN_2022_PROGRAM_ID));
check("supply = 22,000,000,000,000 QC (5 decimals)", m.supply === 22_000_000_000_000n * 100_000n && m.decimals === 5, { supply: m.supply.toString(), decimals: m.decimals });
check("mint authority = none", m.mintAuthority === null);
check("freeze authority = none", m.freezeAuthority === null);
const exts = getExtensionTypes(m.tlvData).map((e) => ExtensionType[e]);
check("extensions are only MetadataPointer + TokenMetadata", exts.sort().join() === ["MetadataPointer", "TokenMetadata"].sort().join(), exts);
const mp = getMetadataPointerState(m);
check("metadata pointer authority none, points at mint", !!mp && mp.authority === null && !!mp.metadataAddress?.equals(MINT));
const md = await retry(() => getTokenMetadata(conn, MINT, "confirmed", TOKEN_2022_PROGRAM_ID));
check("metadata update authority none", !md?.updateAuthority || md.updateAuthority.equals(PublicKey.default), md?.updateAuthority?.toBase58());
check("metadata name QuantCoin / symbol QC", md?.name === "QuantCoin" && md?.symbol === "QC", { name: md?.name, symbol: md?.symbol, uri: md?.uri });
// All holders (getProgramAccounts by mint) vs transparency vault list
const html = readFileSync(process.argv[2], "utf8");
const listed = [...html.matchAll(/key:"(\w+)".*?vault:"(\w+)", tokenAccount:"(\w+)"/g)].map((x) => ({ key: x[1], vault: x[2], ta: x[3] }));
check("transparency lists vaults", listed.length > 0, listed.length);
let all: { pubkey: PublicKey; amount: bigint; owner: string }[] = [];
try {
  const accs = await retry(() => conn.getProgramAccounts(TOKEN_2022_PROGRAM_ID, { filters: [{ memcmp: { offset: 0, bytes: MINT.toBase58() } }] }));
  all = accs.map((a) => { const u = unpackAccount(a.pubkey, a.account, TOKEN_2022_PROGRAM_ID); return { pubkey: a.pubkey, amount: u.amount, owner: u.owner.toBase58() }; });
} catch (e) { console.log("WARN getProgramAccounts refused:", String(e).slice(0, 200)); }
let listedSum = 0n;
for (const v of listed) {
  const ai = await retry(() => conn.getAccountInfo(P(v.ta)));
  let amt = 0n, owner = "closed";
  if (ai) { const u = unpackAccount(P(v.ta), ai, TOKEN_2022_PROGRAM_ID); amt = u.amount; owner = u.owner.toBase58(); check(`${v.key}: token account mint=QC owner=listed vault, no delegate/close authority`, u.mint.equals(MINT) && owner === v.vault && u.delegate === null && u.closeAuthority === null, { owner }); }
  listedSum += amt;
  console.log(`  ${v.key.padEnd(14)} ${v.ta} ${(Number(amt) / 1e5).toLocaleString("en-US")} QC (${owner === "closed" ? "account closed" : "open"})`);
}
console.log("listed vault sum QC:", (listedSum / 100000n).toString(), "raw", listedSum.toString());
if (all.length) {
  const tas = new Set(listed.map((v) => v.ta));
  const outside = all.filter((a) => !tas.has(a.pubkey.toBase58()) && a.amount > 0n);
  const outSum = outside.reduce((s, a) => s + a.amount, 0n), tot = all.reduce((s, a) => s + a.amount, 0n);
  for (const o of outside) console.log(`  outside: ${o.pubkey.toBase58()} owner ${o.owner} ${(Number(o.amount) / 1e5).toLocaleString("en-US")} QC`);
  check("listed vaults + outside holdings = 22,000,000,000,000 QC exactly", listedSum + outSum === m.supply, { listed: listedSum.toString(), outside: outSum.toString(), outsideAccounts: outside.length });
  check("sum of every QC token account = supply", tot === m.supply, { accounts: all.length, total: tot.toString() });
} else check("listed + outside = supply (holder enumeration unavailable)", false, "RPC refused getProgramAccounts");
// Pool
const amm = new CpAmm(conn);
const st = await retry(() => amm.fetchPoolState(POOL)); const pos = await retry(() => amm.fetchPositionState(POS));
check("position belongs to pool", pos.pool.equals(POOL));
check("project position fully locked (permanent = total liquidity, unlocked 0, vested 0)", pos.unlockedLiquidity.isZero() && pos.vestedLiquidity.isZero() && pos.permanentLockedLiquidity.gt(new (pos.unlockedLiquidity.constructor as any)(0)),
  { permanent: pos.permanentLockedLiquidity.toString(), unlocked: pos.unlockedLiquidity.toString(), vested: pos.vestedLiquidity.toString(), poolLiquidity: st.liquidity.toString(), poolPermanent: st.permanentLockLiquidity?.toString() });
check("pool token A or B = QC", st.tokenAMint.equals(MINT) || st.tokenBMint.equals(MINT), { a: st.tokenAMint.toBase58(), b: st.tokenBMint.toBase58() });
console.log(`TOTAL ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
