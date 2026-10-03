// Read-only re-audit of everything the mainnet launch put on chain. Sends no
// transactions and signs nothing; vault key files are read only to derive addresses.
// Env: QC_NET=mainnet, RPC_URL, PAYER (unused but required by env()), PROGRAM_ID.
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getMint, getMetadataPointerState, getTokenMetadata, unpackAccount } from "@solana/spl-token";
import * as multisig from "@sqds/multisig";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { NET, env, loadVault, vaultAddress, vaultTokenAccount } from "./qc.ts";

const { conn, program } = env();
const g = JSON.parse(readFileSync(`genesis-${NET}.json`, "utf8"));
const sq = JSON.parse(readFileSync(`squads-${NET}.json`, "utf8"));
const mint = new PublicKey(g.mint);
const EXPECT_SO = "93abe8efcc344cfb43f25dca968af2bc4991feb555e0743f7bd06de8b0839b2e";
const UNIT = 100_000n;
const OPEN: [string, bigint][] = [
  ["alloc-founder-1", 1_100_000_000_000n], ["alloc-founder-2", 1_100_000_000_000n],
  ["alloc-founder-3", 1_100_000_000_000n], ["alloc-founder-4", 1_100_000_000_000n],
  ["alloc-liquidity", 4_400_000_000_000n], ["alloc-airdrop", 3_300_000_000_000n],
  ["alloc-reserve", 2_200_000_000_000n], ["treasury-8", 7_700_000_000_000n],
];
const SPENT = ["genesis", ...Array.from({ length: 7 }, (_, i) => `treasury-${i + 1}`)];

const checks: { check: string; ok: boolean; detail?: unknown }[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { checks.push({ check: name, ok, detail }); console.log(ok ? "PASS" : "FAIL", name, detail ?? ""); };
const pause = () => new Promise((r) => setTimeout(r, 1200));
const info = async (a: PublicKey) => { await pause(); return conn.getAccountInfo(a); };

// 1. Program: executable, bytes match the audited build, authority = multisig vault.
const prog = (await info(program))!;
check("program is executable, owned by upgradeable loader", prog.executable && prog.owner.toBase58() === "BPFLoaderUpgradeab1e11111111111111111111111");
const pd = new PublicKey(prog.data.subarray(4, 36));
const pdata = (await info(pd))!;
const auth = pdata.data[12] === 1 ? new PublicKey(pdata.data.subarray(13, 45)).toBase58() : null;
check("upgrade authority = Squads vault", auth === sq.vault, auth);
const so = pdata.data.subarray(45);
check("program bytes = audited build (sha256)", createHash("sha256").update(so).digest("hex") === EXPECT_SO, so.length + " bytes");

// 2. Multisig: owned by Squads, 2-of-3, the three expected members, no config authority.
const msInfo = (await info(new PublicKey(sq.multisig)))!;
check("multisig owned by Squads v4", msInfo.owner.toBase58() === "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");
const [ms] = multisig.accounts.Multisig.fromAccountInfo(msInfo);
check("multisig threshold 2 of 3", ms.threshold === 2 && ms.members.length === 3, { threshold: ms.threshold, members: ms.members.length });
check("multisig members as recorded", ms.members.map((m) => m.key.toBase58()).sort().join() === [...sq.members].sort().join());
check("multisig has no config authority (changes need a vote)", ms.configAuthority.equals(PublicKey.default));
check("multisig has no time lock", ms.timeLock === 0, ms.timeLock);
check("Squads vault PDA derives from multisig", multisig.getVaultPda({ multisigPda: new PublicKey(sq.multisig), index: 0 })[0].toBase58() === sq.vault);

// 3. Mint: fixed supply, every authority revoked, metadata permanent.
await pause();
const m = await getMint(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
check("supply = 22,000,000,000,000 QC", m.supply === 22_000_000_000_000n * UNIT, m.supply.toString());
check("decimals = 5", m.decimals === 5);
check("mint authority revoked", m.mintAuthority === null);
check("freeze authority revoked", m.freezeAuthority === null);
const mp = getMetadataPointerState(m);
check("metadata pointer authority revoked, points at the mint", !!mp && mp.authority === null && mp.metadataAddress?.equals(mint) === true);
await pause();
const md = await getTokenMetadata(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
check("metadata update authority revoked", !md?.updateAuthority || md.updateAuthority.equals(PublicKey.default), md?.updateAuthority?.toBase58());
check("metadata name/symbol", md?.name === "QuantCoin" && md?.symbol === "QC");
await pause();
const uriOk = md?.uri ? (await fetch(md.uri)).ok : false;
check("metadata URI reachable", uriOk, md?.uri);

// 4. Vaults: open ones hold exactly their allocation; spent ones carry the marker.
let sum = 0n;
for (const [name, qc] of OPEN) {
  const v = loadVault(name);
  const pda = vaultAddress(program, v)[0], ta = vaultTokenAccount(program, mint, v);
  const pInfo = await info(pda);
  const tInfo = (await info(ta))!;
  const acc = unpackAccount(ta, tInfo, TOKEN_2022_PROGRAM_ID);
  sum += acc.amount;
  check(`${name}: open, owned by its PDA, holds ${qc} QC`,
    !pInfo?.owner.equals(program) && acc.owner.equals(pda) && acc.mint.equals(mint) && acc.amount === qc * UNIT && acc.delegate === null && acc.closeAuthority === null,
    { vault: pda.toBase58(), amount: acc.amount.toString(), delegate: acc.delegate?.toBase58() ?? null });
}
check("open vaults hold the whole supply", sum === m.supply, sum.toString());
for (const name of SPENT) {
  const v = loadVault(name);
  const pda = vaultAddress(program, v)[0], ta = vaultTokenAccount(program, mint, v);
  const pInfo = await info(pda), tInfo = await info(ta);
  check(`${name}: spent marker set, token account closed`, !!pInfo?.owner.equals(program) && pInfo.data.length === 0 && !tInfo, pda.toBase58());
}

// 5. Nobody else holds QC. Supply is the sum of every token account's balance,
//    so vaults holding the whole supply already proves it; the RPC listing is a
//    second view that public endpoints often refuse.
await pause();
const ours = new Set(OPEN.map(([n]) => vaultTokenAccount(program, mint, loadVault(n)).toBase58()));
const largest = await conn.getTokenLargestAccounts(mint).catch(() => null);
const foreign = largest?.value.filter((a) => BigInt(a.amount) > 0n && !ours.has(a.address.toBase58())) ?? [];
check("no token account outside the vaults holds QC", sum === m.supply && foreign.length === 0,
  largest ? { foreign: foreign.map((a) => a.address.toBase58()) } : "implied by supply == vault sum (RPC refused getTokenLargestAccounts)");

const failed = checks.filter((c) => !c.ok).length;
writeFileSync(new URL(`../audit/${NET}-state-verify.json`, import.meta.url),
  JSON.stringify({ date: new Date().toISOString(), network: NET, passed: checks.length - failed, failed, checks }, null, 2));
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
