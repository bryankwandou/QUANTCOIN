// Open the QC/SOL pool on Meteora DAMM v2: single-sided (QC only, no SOL from
// the project), starting price set by FDV_SOL, liquidity permanently locked
// (the position can never be withdrawn; its trading fees stay claimable).
// Anti-sniper: the fee starts at 50% when the pool opens and decays to 0.25%
// over one hour; a dynamic fee adds more when the price swings. Fees are
// collected in SOL only.
// The payer must already hold the QC, sent out of the liquidity vault with spend.ts.
// Env: RPC_URL, PAYER, PROGRAM_ID, MINT, QC_BASE (base units, 5 decimals),
//      FDV_SOL (value of the whole 22T supply at the opening price),
//      OPEN_AT (unix seconds the pool starts trading), SEND=1 to broadcast.
import { ComputeBudgetProgram, Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import { ActivationType, BaseFeeMode, CollectFeeMode, CpAmm, MAX_SQRT_PRICE, deriveCustomizablePoolAddress,
  getBaseFeeParams, getDynamicFeeParams, getSqrtPriceFromPrice } from "@meteora-ag/cp-amm-sdk";
import { env } from "./qc.ts";

const SUPPLY_QC = 22_000_000_000_000;
const { conn, payer } = env();
const mint = new PublicKey(process.env.MINT!);
const qc = new BN(process.env.QC_BASE!);
const fdv = Number(process.env.FDV_SOL!), openAt = Number(process.env.OPEN_AT!);
const send = process.env.SEND === "1";
if (!(fdv > 0) || !(openAt > 0)) throw new Error("set FDV_SOL and OPEN_AT");

const pool = deriveCustomizablePoolAddress(mint, NATIVE_MINT);
if (await conn.getAccountInfo(pool)) throw new Error(`pool ${pool.toBase58()} already exists`);
const qcAta = getAssociatedTokenAddressSync(mint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);
const held = BigInt((await conn.getTokenAccountBalance(qcAta)).value.amount);
if (held < BigInt(qc.toString())) throw new Error(`payer holds ${held} QC base units, needs ${qc}`);
const lamports = await conn.getBalance(payer.publicKey);
const price = fdv / SUPPLY_QC; // SOL per QC
console.log({ pool: pool.toBase58(), payer: payer.publicKey.toBase58(), qcBase: qc.toString(), fdvSol: fdv,
  priceSolPerQc: price, openAt: new Date(openAt * 1000).toISOString(), payerSol: lamports / LAMPORTS_PER_SOL });

const cpAmm = new CpAmm(conn);
// Single-sided: the range starts at the opening price, so the pool holds only QC
// and the price can never trade below where it opened.
const initSqrtPrice = getSqrtPriceFromPrice(price.toFixed(20), 5, 9);
const liquidityDelta = cpAmm.preparePoolCreationSingleSide({
  tokenAAmount: qc, minSqrtPrice: initSqrtPrice, maxSqrtPrice: MAX_SQRT_PRICE, initSqrtPrice, collectFeeMode: CollectFeeMode.OnlyB });
const baseFee = getBaseFeeParams({ baseFeeMode: BaseFeeMode.FeeTimeSchedulerExponential,
  feeTimeSchedulerParam: { startingFeeBps: 5000, endingFeeBps: 25, numberOfPeriod: 60, totalDuration: 3600 } });
const positionNft = Keypair.generate();
const { tx, position } = await cpAmm.createCustomPool({
  payer: payer.publicKey, creator: payer.publicKey, positionNft: positionNft.publicKey,
  tokenAMint: mint, tokenBMint: NATIVE_MINT, tokenAAmount: qc, tokenBAmount: new BN(0),
  sqrtMinPrice: initSqrtPrice, sqrtMaxPrice: MAX_SQRT_PRICE, liquidityDelta, initSqrtPrice,
  poolFees: { baseFee, compoundingFeeBps: 0, padding: 0, dynamicFee: getDynamicFeeParams(25) },
  hasAlphaVault: false, activationType: ActivationType.Timestamp, collectFeeMode: CollectFeeMode.OnlyB,
  activationPoint: new BN(openAt),
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
  tokenAVault: st.tokenAVault.toBase58(), activationPoint: st.activationPoint.toString(),
  lockedLiquidity: pos.permanentLockedLiquidity.toString(), unlockedLiquidity: pos.unlockedLiquidity.toString(),
  solSpent: (lamports - await conn.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL });
