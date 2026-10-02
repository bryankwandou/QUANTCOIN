// Open the QC/SOL pool on Meteora DAMM v2 with the liquidity permanently locked
// (the position can never be withdrawn; its trading fees stay claimable).
// The payer must already hold the QC, sent out of the liquidity vault with spend.ts.
// Env: RPC_URL, PAYER, MINT, QC_BASE (base units, 5 decimals), SOL_LAMPORTS,
//      SEND=1 to broadcast (default: simulate only).
import { ComputeBudgetProgram, Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import { ActivationType, BaseFeeMode, CollectFeeMode, CpAmm, MAX_SQRT_PRICE, MIN_SQRT_PRICE, deriveCustomizablePoolAddress, getBaseFeeParams } from "@meteora-ag/cp-amm-sdk";
import { env } from "./qc.ts";

const { conn, payer } = env();
const mint = new PublicKey(process.env.MINT!);
const qc = new BN(process.env.QC_BASE!), sol = new BN(process.env.SOL_LAMPORTS!);
const send = process.env.SEND === "1";

const pool = deriveCustomizablePoolAddress(mint, NATIVE_MINT);
if (await conn.getAccountInfo(pool)) throw new Error(`pool ${pool.toBase58()} already exists`);
const qcAta = getAssociatedTokenAddressSync(mint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);
const held = BigInt((await conn.getTokenAccountBalance(qcAta)).value.amount);
if (held < BigInt(qc.toString())) throw new Error(`payer holds ${held} QC base units, needs ${qc}`);
const lamports = await conn.getBalance(payer.publicKey);
console.log({ pool: pool.toBase58(), payer: payer.publicKey.toBase58(), qcBase: qc.toString(), sol: sol.toNumber() / LAMPORTS_PER_SOL,
  payerSol: lamports / LAMPORTS_PER_SOL, priceSolPerQc: sol.toNumber() / LAMPORTS_PER_SOL / (Number(qc.toString()) / 1e5) });

const cpAmm = new CpAmm(conn);
const { initSqrtPrice, liquidityDelta } = cpAmm.preparePoolCreationParams({
  tokenAAmount: qc, tokenBAmount: sol, minSqrtPrice: MIN_SQRT_PRICE, maxSqrtPrice: MAX_SQRT_PRICE, collectFeeMode: CollectFeeMode.BothToken });
// Flat 0.25% trading fee, like Raydium's standard pool.
const baseFee = getBaseFeeParams({ baseFeeMode: BaseFeeMode.FeeTimeSchedulerLinear,
  feeTimeSchedulerParam: { startingFeeBps: 25, endingFeeBps: 25, numberOfPeriod: 0, totalDuration: 0 } });
const positionNft = Keypair.generate();
const { tx, position } = await cpAmm.createCustomPool({
  payer: payer.publicKey, creator: payer.publicKey, positionNft: positionNft.publicKey,
  tokenAMint: mint, tokenBMint: NATIVE_MINT, tokenAAmount: qc, tokenBAmount: sol,
  sqrtMinPrice: MIN_SQRT_PRICE, sqrtMaxPrice: MAX_SQRT_PRICE, liquidityDelta, initSqrtPrice,
  poolFees: { baseFee, compoundingFeeBps: 0, padding: 0, dynamicFee: null },
  hasAlphaVault: false, activationType: ActivationType.Timestamp, collectFeeMode: CollectFeeMode.BothToken, activationPoint: null,
  tokenAProgram: TOKEN_2022_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, isLockLiquidity: true,
});
tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
tx.feePayer = payer.publicKey;
tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
tx.partialSign(payer, positionNft);

const sim = await conn.simulateTransaction(tx);
if (sim.value.err) { console.log(sim.value.logs?.slice(-8)); throw new Error(`simulation failed: ${JSON.stringify(sim.value.err)}`); }
console.log({ simulation: "ok", cu: sim.value.unitsConsumed });
if (!send) process.exit(0);

const sig = await sendAndConfirmTransaction(conn, tx, [payer, positionNft]);
const st = await cpAmm.fetchPoolState(pool), pos = await cpAmm.fetchPositionState(position);
if (!pos.permanentLockedLiquidity.eq(st.liquidity) || !pos.unlockedLiquidity.isZero())
  throw new Error("liquidity is not fully locked; check the position before announcing");
console.log({ tx: sig, pool: pool.toBase58(), position: position.toBase58(), positionNft: positionNft.publicKey.toBase58(),
  lockedLiquidity: pos.permanentLockedLiquidity.toString(), unlockedLiquidity: pos.unlockedLiquidity.toString(),
  solSpent: (lamports - await conn.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL });
