// Replace one Squads member: add NEW_MEMBER, remove OLD_MEMBER, threshold
// stays 2 of 3. Use it to move a member key off the operator laptop (two of
// three keys on one machine make 2-of-3 a 1-of-1).
// The 24-hour time lock applies to config transactions too, so run it twice:
// the first run creates and approves, the run after the lock executes.
// Env: RPC_URL, PAYER, QC_NET, MEMBER_A, MEMBER_B (keypair files of two current
//      members, neither of them OLD_MEMBER's file if avoidable), NEW_MEMBER
//      (base58 pubkey, generated on a separate device), OLD_MEMBER (base58),
//      SEND=1 to broadcast (default: show the plan only).
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import { readFileSync } from "node:fs";
import { NET } from "./qc.ts";

if (!process.env.QC_NET) throw new Error("set QC_NET=mainnet (or devnet) so the right Squads config is used");
const sq = JSON.parse(readFileSync(new URL(`./squads-${NET}.json`, import.meta.url), "utf8"));
const msPda = new PublicKey(sq.multisig);
const conn = new Connection(process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
const key = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
const newMember = new PublicKey(process.env.NEW_MEMBER!);
const oldMember = new PublicKey(process.env.OLD_MEMBER!);

const ms = await multisig.accounts.Multisig.fromAccountAddress(conn, msPda);
const isMember = (k: PublicKey) => ms.members.some((x) => x.key.equals(k));
console.log({ multisig: msPda.toBase58(), threshold: ms.threshold, timeLock: ms.timeLock,
  members: ms.members.map((m) => m.key.toBase58()), add: newMember.toBase58(), remove: oldMember.toBase58() });
if (!isMember(oldMember)) throw new Error("OLD_MEMBER is not a member");
if (isMember(newMember)) throw new Error("NEW_MEMBER is already a member");
if (ms.members.length !== 3 || ms.threshold !== 2) throw new Error("expected 2 of 3; check the multisig before rotating");
if (process.env.SEND !== "1") process.exit(0);

const payer = key(process.env.PAYER!);
const a = key(process.env.MEMBER_A!), b = key(process.env.MEMBER_B!);
for (const m of [a, b]) if (!isMember(m.publicKey)) throw new Error(`${m.publicKey.toBase58()} is not a member`);
// Resume the latest proposal if it is still ours and active (second run).
let index = BigInt(ms.transactionIndex.toString());
let prop = await multisig.accounts.Proposal.fromAccountAddress(conn, multisig.getProposalPda({ multisigPda: msPda, transactionIndex: index })[0]).catch(() => null);
const resume = !!prop && (prop.status.__kind === "Active" || prop.status.__kind === "Approved") && index > BigInt(ms.staleTransactionIndex.toString());
if (!resume) { index += 1n; prop = null; }
const tip = () => ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 });
const send = (tx: Transaction, signers: Keypair[]) => sendAndConfirmTransaction(conn, new Transaction().add(tip(), ...tx.instructions), signers, { commitment: "confirmed" });
const approved = (k: PublicKey) => !!prop?.approved.some((x) => x.equals(k));

const create = resume ? "resumed" : await send(new Transaction().add(
  multisig.instructions.configTransactionCreate({ multisigPda: msPda, transactionIndex: index, creator: a.publicKey, rentPayer: payer.publicKey,
    actions: [
      { __kind: "AddMember", newMember: { key: newMember, permissions: multisig.types.Permissions.all() } },
      { __kind: "RemoveMember", oldMember },
    ], memo: `rotate member ${oldMember.toBase58().slice(0, 4)} -> ${newMember.toBase58().slice(0, 4)}` }),
  multisig.instructions.proposalCreate({ multisigPda: msPda, transactionIndex: index, creator: a.publicKey, rentPayer: payer.publicKey }),
  multisig.instructions.proposalApprove({ multisigPda: msPda, transactionIndex: index, member: a.publicKey })), [payer, a]);
const approve = approved(b.publicKey) ? "already" : await send(new Transaction().add(
  multisig.instructions.proposalApprove({ multisigPda: msPda, transactionIndex: index, member: b.publicKey })), [payer, b]);

prop = await multisig.accounts.Proposal.fromAccountAddress(conn, multisig.getProposalPda({ multisigPda: msPda, transactionIndex: index })[0]);
const approvedAt = prop.status.__kind === "Approved" ? Number(prop.status.timestamp) : 0;
const release = approvedAt + ms.timeLock;
if (Date.now() / 1000 < release) {
  console.log({ transactionIndex: index.toString(), create, approve, executeAfter: new Date(release * 1000).toISOString(), next: "run again with SEND=1 after that time" });
  process.exit(0);
}
const execute = await send(new Transaction().add(
  multisig.instructions.configTransactionExecute({ multisigPda: msPda, transactionIndex: index, member: b.publicKey, rentPayer: payer.publicKey })), [payer, b]);
const after = await multisig.accounts.Multisig.fromAccountAddress(conn, msPda);
const ok = after.members.some((m) => m.key.equals(newMember)) && !after.members.some((m) => m.key.equals(oldMember)) && after.threshold === 2;
if (!ok) throw new Error("members did not change as expected");
console.log({ transactionIndex: index.toString(), execute, members: after.members.map((m) => m.key.toBase58()), threshold: after.threshold });
