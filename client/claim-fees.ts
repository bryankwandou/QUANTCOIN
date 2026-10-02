// Claim the project pool position's trading fees (SOL) and move exactly that
// amount to the Squads vault, as LAUNCH.md §3 commits. The liquidity itself is
// locked and cannot be claimed.
// Env: RPC_URL, PAYER (deployer: holds the position NFT), PROGRAM_ID, QC_NET, SEND=1 to broadcast.
import { ComputeBudgetProgram, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { readFileSync } from "node:fs";
import { CpAmm, getUnClaimLpFee } from "@meteora-ag/cp-amm-sdk";
import { NET, env } from "./qc.ts";

const POOL = new PublicKey("AyS1vByiVFsVdsekRZE1mGVY5MHY1YMs59DeGwDwbbwB");
const POSITION = new PublicKey("7Bqgd7AyjAQw6LS9m7QHLTGiF851Net93fJdk8XSDWAt");
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const vault = new PublicKey(JSON.parse(readFileSync(new URL(`./squads-${NET}.json`, import.meta.url), "utf8")).vault);
const { conn, payer } = env();
const send = process.env.SEND === "1";
const cp = new CpAmm(conn);

const ps = await cp.fetchPoolState(POOL), pos = await cp.fetchPositionState(POSITION);
const fee = (getUnClaimLpFee(ps, pos) as { feeTokenB: { toString(): string } }).feeTokenB.toString();
const [nft] = (await cp.getUserPositionByPool(POOL, payer.publicKey)).filter((p) => p.position.equals(POSITION));
if (!nft) throw new Error("PAYER does not hold the project position NFT");
console.log({ squadsVault: vault.toBase58(), unclaimedSol: Number(fee) / LAMPORTS_PER_SOL, payerSol: (await conn.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL });
if (fee === "0") process.exit(0);

const claim = await cp.claimPositionFee({ owner: payer.publicKey, position: POSITION, pool: POOL, positionNftAccount: nft.positionNftAccount,
  tokenAMint: ps.tokenAMint, tokenBMint: ps.tokenBMint, tokenAVault: ps.tokenAVault, tokenBVault: ps.tokenBVault,
  tokenAProgram: TOKEN_2022_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, feePayer: payer.publicKey });
// The claim unwraps the SOL fee into the payer wallet; the transfer in the same
// transaction forwards exactly that amount, so the founder never holds it.
const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ...claim.instructions,
  SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: vault, lamports: BigInt(fee) }),
  new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(`QC pool fees ${fee} lamports -> Squads vault (LAUNCH.md 3)`) }));
tx.feePayer = payer.publicKey;
tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
tx.sign(payer);
const sim = await conn.simulateTransaction(tx);
if (sim.value.err) { console.log(sim.value.logs?.slice(-10)); throw new Error(`simulation failed: ${JSON.stringify(sim.value.err)}`); }
console.log({ simulation: "ok", cu: sim.value.unitsConsumed });
if (!send) process.exit(0);
const before = await conn.getBalance(vault);
const sig = await sendAndConfirmTransaction(conn, tx, [payer]);
const after = await conn.getBalance(vault);
const left = getUnClaimLpFee(await cp.fetchPoolState(POOL), await cp.fetchPositionState(POSITION)) as { feeTokenB: { toString(): string } };
console.log({ tx: sig, movedSol: (after - before) / LAMPORTS_PER_SOL, squadsVaultSol: after / LAMPORTS_PER_SOL, unclaimedLeft: left.feeTokenB.toString() });
