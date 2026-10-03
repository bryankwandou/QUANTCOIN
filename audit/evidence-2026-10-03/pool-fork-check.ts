// Pool checks on a Surfpool fork of mainnet. Ephemeral payer, no real funds.
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, unpackAccount } from "@solana/spl-token";
import { CpAmm, SwapMode, getPriceFromSqrtPrice } from "@meteora-ag/cp-amm-sdk";
import BN from "bn.js";
const RPC = "http://127.0.0.1:8899"; const conn = new Connection(RPC, "confirmed"); const amm = new CpAmm(conn);
const POOL = new PublicKey("AyS1vByiVFsVdsekRZE1mGVY5MHY1YMs59DeGwDwbbwB"), QC = new PublicKey("AsEEaydVYMpghdNTrQoVZTAhJSewZT5xD9WE9hpA68W2");
let pass = 0, fail = 0; const ok = (n: string, c: boolean, d?: unknown) => { c ? pass++ : fail++; console.log(c ? "PASS" : "FAIL", n, d === undefined ? "" : JSON.stringify(d)); };
const rpc = async (m: string, p: string) => (await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: `{"jsonrpc":"2.0","id":1,"method":"${m}","params":${p}}` })).json());
const u = Keypair.generate(); await conn.confirmTransaction(await conn.requestAirdrop(u.publicKey, 100 * LAMPORTS_PER_SOL));
const st0 = await amm.fetchPoolState(POOL);
const floor = st0.sqrtMinPrice, price = (s: BN) => getPriceFromSqrtPrice(s, 5, 9).toString();
console.log("opening floor (sqrtMinPrice) price SOL/QC:", price(floor), "current:", price(st0.sqrtPrice));
ok("current price >= opening floor at fork start", st0.sqrtPrice.gte(floor));
const swap = async (inMint: PublicKey, outMint: PublicKey, amountIn: BN) => {
  const st = await amm.fetchPoolState(POOL);
  const tx = await amm.swap({ payer: u.publicKey, pool: POOL, inputTokenMint: inMint, outputTokenMint: outMint, amountIn, minimumAmountOut: new BN(0),
    tokenAMint: st.tokenAMint, tokenBMint: st.tokenBMint, tokenAVault: st.tokenAVault, tokenBVault: st.tokenBVault, tokenAProgram: TOKEN_2022_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null } as any);
  tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }));
  return sendAndConfirmTransaction(conn, tx, [u]);
};
const qcAta = getAssociatedTokenAddressSync(QC, u.publicKey, false, TOKEN_2022_PROGRAM_ID);
const qcBal = async () => { const i = await conn.getAccountInfo(qcAta); return i ? unpackAccount(qcAta, i, TOKEN_2022_PROGRAM_ID).amount : 0n; };
// buy
await swap(NATIVE_MINT, QC, new BN(1 * LAMPORTS_PER_SOL)); const got = await qcBal();
const st1 = await amm.fetchPoolState(POOL);
ok("buy 1 SOL -> receives QC, price rises", got > 0n && st1.sqrtPrice.gt(st0.sqrtPrice), { qc: got.toString(), price: price(st1.sqrtPrice) });
// sell back
await swap(QC, NATIVE_MINT, new BN(got.toString())); const st2 = await amm.fetchPoolState(POOL);
ok("sell all bought QC -> price falls, stays >= floor", st2.sqrtPrice.lt(st1.sqrtPrice) && st2.sqrtPrice.gte(floor), { price: price(st2.sqrtPrice) });
// dump: give the user 5 trillion QC via cheatcode and try to sell it all
await rpc("surfnet_setTokenAccount", `["${u.publicKey.toBase58()}","${QC.toBase58()}",{"amount":${5_000_000_000_000n * 100_000n}},"${TOKEN_2022_PROGRAM_ID.toBase58()}"]`);
let dumpErr = ""; try { await swap(QC, NATIVE_MINT, new BN((5_000_000_000_000n * 100_000n).toString())); } catch (e) { dumpErr = String(e).slice(0, 160); }
const st3 = await amm.fetchPoolState(POOL);
ok("dump 5T QC: price never below opening floor", st3.sqrtPrice.gte(floor), { price: price(st3.sqrtPrice), refused: dumpErr || "swap executed" });
// many random round trips
for (let i = 0; i < 20; i++) {
  try { if (i % 2 === 0) await swap(NATIVE_MINT, QC, new BN(Math.floor(Math.random() * 5 * LAMPORTS_PER_SOL) + 1000)); else { const b = await qcBal(); if (b > 0n) await swap(QC, NATIVE_MINT, new BN((b / 2n).toString())); } } catch (e) {}
  const s = await amm.fetchPoolState(POOL); if (s.sqrtPrice.lt(floor)) { ok(`random trade #${i}: price >= floor`, false, price(s.sqrtPrice)); }
}
ok("20 random trades: price never below opening floor", (await amm.fetchPoolState(POOL)).sqrtPrice.gte(floor));
console.log(`TOTAL ${pass} pass / ${fail} fail`); process.exit(fail ? 1 : 0);
