// Set the Squads multisig time lock (seconds between approval and execution of
// any later transaction, upgrades included). One config transaction: member A
// creates and approves, member B approves, then it executes.
// Env: RPC_URL, PAYER (pays fees and rent), QC_NET, MEMBER_A, MEMBER_B (member keypair files),
//      TIME_LOCK (seconds), SEND=1 to broadcast (default: show current state only).
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import { readFileSync } from "node:fs";
import { NET } from "./qc.ts";

if (!process.env.QC_NET) throw new Error("set QC_NET=mainnet (or devnet) so the right Squads config is used");
const sq = JSON.parse(readFileSync(new URL(`./squads-${NET}.json`, import.meta.url), "utf8"));
const msPda = new PublicKey(sq.multisig);
const conn = new Connection(process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
const key = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
const payer = key(process.env.PAYER!);
const timeLock = Number(process.env.TIME_LOCK);
if (!Number.isInteger(timeLock) || timeLock < 0 || timeLock > 90 * 86400) throw new Error("TIME_LOCK must be whole seconds, at most 90 days");

const ms = await multisig.accounts.Multisig.fromAccountAddress(conn, msPda);
console.log({ multisig: msPda.toBase58(), threshold: ms.threshold, timeLockNow: ms.timeLock, timeLockNew: timeLock, txIndex: ms.transactionIndex.toString() });
if (process.env.SEND !== "1") process.exit(0);
if (ms.timeLock === timeLock) { console.log("already set"); process.exit(0); }

const a = key(process.env.MEMBER_A!), b = key(process.env.MEMBER_B!);
for (const m of [a, b]) if (!ms.members.some((x) => x.key.equals(m.publicKey))) throw new Error(`${m.publicKey.toBase58()} is not a member`);
// Resume: if the latest proposal is still active, it is ours from an earlier
// run whose later steps expired; continue it instead of opening a new one.
let index = BigInt(ms.transactionIndex.toString());
let prop = await multisig.accounts.Proposal.fromAccountAddress(conn, multisig.getProposalPda({ multisigPda: msPda, transactionIndex: index })[0]).catch(() => null);
const resume = !!prop && prop.status.__kind === "Active" && index > BigInt(ms.staleTransactionIndex.toString());
if (!resume) { index += 1n; prop = null; }
// Public RPCs drop low-fee transactions under load; a small priority fee lands them.
const tip = () => ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 });
const send = (tx: Transaction, signers: Keypair[]) => sendAndConfirmTransaction(conn, new Transaction().add(tip(), ...tx.instructions), signers, { commitment: "confirmed" });
const approved = (k: PublicKey) => !!prop?.approved.some((x) => x.equals(k));

const create = resume ? "resumed" : await send(new Transaction().add(
  multisig.instructions.configTransactionCreate({ multisigPda: msPda, transactionIndex: index, creator: a.publicKey, rentPayer: payer.publicKey,
    actions: [{ __kind: "SetTimeLock", newTimeLock: timeLock }], memo: `time lock ${timeLock}s` }),
  multisig.instructions.proposalCreate({ multisigPda: msPda, transactionIndex: index, creator: a.publicKey, rentPayer: payer.publicKey }),
  multisig.instructions.proposalApprove({ multisigPda: msPda, transactionIndex: index, member: a.publicKey })), [payer, a]);
const approve = approved(b.publicKey) ? "already" : await send(new Transaction().add(
  multisig.instructions.proposalApprove({ multisigPda: msPda, transactionIndex: index, member: b.publicKey })), [payer, b]);
const execute = await send(new Transaction().add(
  multisig.instructions.configTransactionExecute({ multisigPda: msPda, transactionIndex: index, member: b.publicKey, rentPayer: payer.publicKey })), [payer, b]);
const after = await multisig.accounts.Multisig.fromAccountAddress(conn, msPda);
if (after.timeLock !== timeLock) throw new Error(`time lock is ${after.timeLock}, expected ${timeLock}`);
console.log({ transactionIndex: index.toString(), create, approve, execute, timeLock: after.timeLock });
