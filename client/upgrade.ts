// Upgrade the program through the Squads multisig that holds its upgrade authority.
// Env: RPC_URL, PAYER (deployer: pays every fee and rent, gets the buffer rent back),
//      PROGRAM_ID, SO (default ../target/deploy/qc_vault.so), MEMBER (a member keypair, for
//      propose/approve/execute), BUFFER (buffer address, after the buffer step).
// Steps (argv[2]):
//   plan     read-only: sizes, rent, balances, exact SOL each wallet needs
//   extend   deployer grows the program data account so SO fits (no authority needed)
//   buffer   upload SO to a fresh buffer, then hand the buffer to the Squads vault
//   propose  wrap the upgrade in a vault transaction + proposal; MEMBER approves
//   approve  MEMBER approves the open upgrade proposal
//   execute  run it once two members approved
//   verify   compare the deployed bytes with SO
// The buffer is checked byte for byte against SO before anyone is asked to approve.
// Mainnet facts (simulated 2026-10-01): ExtendProgramChecked is not enabled, and the
// unchecked ExtendProgram refuses fewer than 10,240 extra bytes.
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY, SYSVAR_RENT_PUBKEY,
  Transaction, TransactionInstruction, TransactionMessage, sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NET } from "./qc.ts";

const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const PROGRAMDATA_META = 45, BUFFER_META = 37, MIN_EXTEND = 10_240;
// RPC defaults to mainnet while NET defaults to devnet; never guess which multisig is meant.
if (!process.env.QC_NET) throw new Error("set QC_NET=mainnet (or devnet) so the right Squads config is used");
const sq = JSON.parse(readFileSync(new URL(`./squads-${NET}.json`, import.meta.url), "utf8"));
const msPda = new PublicKey(sq.multisig), vault = new PublicKey(sq.vault);
const rpc = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const conn = new Connection(rpc, "confirmed");
const program = new PublicKey(process.env.PROGRAM_ID!);
const soPath = process.env.SO ?? fileURLToPath(new URL("../target/deploy/qc_vault.so", import.meta.url));
const so = readFileSync(soPath);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const key = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
const payer = () => key(process.env.PAYER!);
const member = () => key(process.env.MEMBER!);
const [programData] = PublicKey.findProgramAddressSync([program.toBuffer()], LOADER);
const sol = (l: number) => (l / 1e9).toFixed(6);
// TAG keeps a dry run (e.g. TAG=surfpool) from touching the real run's state and buffer key.
const TAG = process.env.TAG ?? NET;
const stateFile = new URL(`./upgrade-${TAG}.json`, import.meta.url);
const state = () => { try { return JSON.parse(readFileSync(stateFile, "utf8")); } catch { return {}; } };
const save = (s: object) => writeFileSync(stateFile, JSON.stringify({ ...state(), ...s }, null, 2));

const u32 = (tag: number, n?: number) => {
  const b = Buffer.alloc(n === undefined ? 4 : 8);
  b.writeUInt32LE(tag, 0);
  if (n !== undefined) b.writeUInt32LE(n, 4);
  return b;
};

/** ExtendProgram (6): anyone may grow a program; `payer` funds the extra rent. */
const extendIx = (extra: number, payer: PublicKey) => new TransactionInstruction({
  programId: LOADER, data: u32(6, extra),
  keys: [
    { pubkey: programData, isSigner: false, isWritable: true },
    { pubkey: program, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: payer, isSigner: true, isWritable: true },
  ],
});

/** Upgrade (3): buffer -> programdata, leftover buffer lamports to `spill`. */
const upgradeIx = (buffer: PublicKey, spill: PublicKey) => new TransactionInstruction({
  programId: LOADER, data: u32(3),
  keys: [
    { pubkey: programData, isSigner: false, isWritable: true },
    { pubkey: program, isSigner: false, isWritable: true },
    { pubkey: buffer, isSigner: false, isWritable: true },
    { pubkey: spill, isSigner: false, isWritable: true },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: vault, isSigner: true, isWritable: false },
  ],
});

async function programDataInfo() {
  const pd = await conn.getAccountInfo(programData);
  if (!pd) throw new Error("program data account not found");
  const auth = pd.data[12] ? new PublicKey(pd.data.subarray(13, 45)) : null;
  return { pd, capacity: pd.data.length - PROGRAMDATA_META, auth };
}

/** Bytes and rent the deployer must add so the program data account can hold SO. */
async function extension() {
  const { pd, capacity } = await programDataInfo();
  const extra = so.length > capacity ? Math.max(MIN_EXTEND, so.length - capacity) : 0;
  const need = await conn.getMinimumBalanceForRentExemption(PROGRAMDATA_META + capacity + extra);
  return { extra, rent: Math.max(0, need - pd.lamports), capacity, lamports: pd.lamports };
}

async function checkBuffer(buffer: PublicKey) {
  const b = await conn.getAccountInfo(buffer);
  if (!b?.owner.equals(LOADER)) throw new Error(`${buffer} is not a loader buffer`);
  if (b.data.readUInt32LE(0) !== 1 || !b.data[4]) throw new Error(`${buffer} is not an open buffer`);
  const auth = new PublicKey(b.data.subarray(5, 37));
  const body = b.data.subarray(BUFFER_META, BUFFER_META + so.length);
  if (sha(body) !== sha(so) || b.data.length !== BUFFER_META + so.length)
    throw new Error(`buffer bytes differ from ${soPath}`);
  return auth;
}

/** The open upgrade proposal recorded by `propose`, re-read from chain. */
async function current() {
  const s = state();
  if (!s.transactionIndex) throw new Error("no proposal recorded; run propose first");
  const index = BigInt(s.transactionIndex);
  const [proposalPda] = multisig.getProposalPda({ multisigPda: msPda, transactionIndex: index });
  const p = await multisig.accounts.Proposal.fromAccountAddress(conn, proposalPda);
  const ms = await multisig.accounts.Multisig.fromAccountAddress(conn, msPda);
  return { s, index, p, ms };
}

const step = process.argv[2];

if (step === "plan") {
  const { capacity, auth } = await programDataInfo();
  const ext = await extension();
  const bufRent = await conn.getMinimumBalanceForRentExemption(BUFFER_META + so.length);
  const writes = Math.ceil(so.length / 900);
  const deployer = payer().publicKey;
  const [dBal, vBal] = await Promise.all([conn.getBalance(deployer), conn.getBalance(vault)]);
  // buffer rent + upload/propose fees + vault-transaction & proposal account rent (refundable later)
  const sqRent = await conn.getMinimumBalanceForRentExemption(1200);
  const dNeed = ext.rent + bufRent + (writes + 8) * 5000 + 2 * sqRent;
  const vNeed = 0;
  console.log({
    program: program.toBase58(), programData: programData.toBase58(),
    upgradeAuthority: auth?.toBase58(), authorityIsSquadsVault: auth?.equals(vault),
    deployedCapacity: capacity, newSize: so.length, newSha256: sha(so), extendBy: ext.extra,
    extendRentSol: sol(ext.rent),
    deployer: deployer.toBase58(), deployerSol: sol(dBal), deployerNeedsSol: sol(dNeed),
    deployerShortSol: sol(Math.max(0, dNeed - dBal)),
    squadsVault: vault.toBase58(), vaultSol: sol(vBal), vaultNeedsSol: sol(vNeed),
    vaultShortSol: sol(Math.max(0, vNeed - vBal)),
    bufferRentReturnedAfterUpgrade: sol(bufRent),
  });
} else if (step === "extend") {
  const ext = await extension();
  if (!ext.extra) { console.log({ extend: "not needed", capacity: ext.capacity }); process.exit(0); }
  const fee = payer();
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }),
    extendIx(ext.extra, fee.publicKey));
  const sig = await sendAndConfirmTransaction(conn, tx, [fee], { commitment: "confirmed" });
  const after = await programDataInfo();
  console.log({ extendedBy: ext.extra, capacity: after.capacity, rentSol: sol(ext.rent), tx: sig });
} else if (step === "buffer") {
  const { auth } = await programDataInfo();
  if (!auth?.equals(vault)) throw new Error(`upgrade authority is ${auth}, not the Squads vault`);
  const bufKp = Keypair.generate();
  const bufFile = new URL(`./upgrade-buffer-${TAG}.json`, import.meta.url);
  writeFileSync(bufFile, JSON.stringify([...bufKp.secretKey]));
  save({ buffer: bufKp.publicKey.toBase58(), soSha256: sha(so), soLen: so.length });
  const cli = (args: string[]) => execFileSync("solana", ["-u", rpc, "-k", process.env.PAYER!, ...args], { stdio: "inherit" });
  const bufPath = fileURLToPath(bufFile);
  cli(["program", "write-buffer", soPath, "--buffer", bufPath, "--with-compute-unit-price", "1000"]);
  cli(["program", "set-buffer-authority", bufKp.publicKey.toBase58(), "--new-buffer-authority", vault.toBase58()]);
  const a = await checkBuffer(bufKp.publicKey);
  if (!a.equals(vault)) throw new Error(`buffer authority is ${a}`);
  console.log({ buffer: bufKp.publicKey.toBase58(), authority: a.toBase58(), sha256: sha(so), ok: true });
} else if (step === "propose") {
  const buffer = new PublicKey(process.env.BUFFER ?? state().buffer);
  const a = await checkBuffer(buffer);
  if (!a.equals(vault)) throw new Error(`buffer authority is ${a}, not the Squads vault`);
  const ext = await extension();
  if (ext.extra) throw new Error(`program data holds ${ext.capacity} bytes, SO is ${so.length}; run extend first`);
  const fee = payer(), m = member();
  const ms = await multisig.accounts.Multisig.fromAccountAddress(conn, msPda);
  if (!ms.members.some((x) => x.key.equals(m.publicKey))) throw new Error(`${m.publicKey} is not a member`);
  const index = BigInt(ms.transactionIndex.toString()) + 1n;
  const ixs = [upgradeIx(buffer, fee.publicKey)];
  const { blockhash } = await conn.getLatestBlockhash();
  const message = new TransactionMessage({ payerKey: vault, recentBlockhash: blockhash, instructions: ixs });
  const memo = `qc-vault upgrade sha256 ${sha(so).slice(0, 16)}`;
  // One transaction: create, open the proposal, first approval. All land or none.
  // Built from instructions: rpc.proposalCreate (sdk 2.1.4) drops rentPayer and
  // bills the creator, whose wallet holds no SOL.
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }),
    multisig.instructions.vaultTransactionCreate({
      multisigPda: msPda, transactionIndex: index, creator: m.publicKey, rentPayer: fee.publicKey,
      vaultIndex: 0, ephemeralSigners: 0, transactionMessage: message, memo,
    }),
    multisig.instructions.proposalCreate({
      multisigPda: msPda, transactionIndex: index, creator: m.publicKey, rentPayer: fee.publicKey,
    }),
    multisig.instructions.proposalApprove({ multisigPda: msPda, transactionIndex: index, member: m.publicKey }),
  );
  const sig = await sendAndConfirmTransaction(conn, tx, [fee, m], { commitment: "confirmed" });
  save({ transactionIndex: index.toString(), buffer: buffer.toBase58(), soSha256: sha(so), proposeTx: sig });
  console.log({ transactionIndex: index.toString(), approvedBy: m.publicKey.toBase58(), memo, tx: sig });
} else if (step === "approve") {
  const { index, p } = await current();
  const m = member();
  if (p.approved.some((k) => k.equals(m.publicKey))) throw new Error("this member already approved");
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(
    multisig.instructions.proposalApprove({ multisigPda: msPda, transactionIndex: index, member: m.publicKey }),
  ), [payer(), m], { commitment: "confirmed" });
  console.log({ transactionIndex: index.toString(), approvedBy: m.publicKey.toBase58(), tx: sig });
} else if (step === "execute") {
  const { index, p, ms } = await current();
  if (p.approved.length < ms.threshold) throw new Error(`${p.approved.length} of ${ms.threshold} approvals`);
  await checkBuffer(new PublicKey(state().buffer));
  const fee = payer();
  const sig = await multisig.rpc.vaultTransactionExecute({
    connection: conn, feePayer: fee, multisigPda: msPda, transactionIndex: index, member: member().publicKey,
    signers: [member()], sendOptions: { skipPreflight: false },
  });
  await conn.confirmTransaction(sig, "confirmed");
  save({ executeTx: sig });
  console.log({ executed: index.toString(), tx: sig });
} else if (step === "verify") {
  const { pd, auth } = await programDataInfo();
  const body = pd.data.subarray(PROGRAMDATA_META, PROGRAMDATA_META + so.length);
  const tail = pd.data.subarray(PROGRAMDATA_META + so.length);
  const ok = sha(body) === sha(so) && tail.every((x) => x === 0);
  console.log({ deployedMatchesSo: ok, sha256: sha(so), authority: auth?.toBase58(), authorityIsSquadsVault: auth?.equals(vault) });
  if (!ok) process.exit(1);
} else {
  console.error("usage: tsx upgrade.ts plan|extend|buffer|propose|approve|execute|verify");
  process.exit(2);
}
