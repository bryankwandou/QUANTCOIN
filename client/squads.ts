// Create the Squads v4 multisig that will hold the program's upgrade authority.
// Env: RPC_URL, PAYER, MEMBERS (comma-separated addresses), THRESHOLD.
// Prints the multisig and its vault (index 0); the vault is the address to hand
// the upgrade authority to. Does not touch the program itself.
import { Keypair, PublicKey } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import { writeFileSync } from "node:fs";
import { NET, env } from "./qc.ts";

const { conn, payer } = env();
const members = process.env.MEMBERS!.split(",").map((m) => new PublicKey(m.trim()));
const threshold = Number(process.env.THRESHOLD ?? 2);
if (new Set(members.map(String)).size !== members.length || threshold < 1 || threshold > members.length)
  throw new Error("bad members/threshold");

const createKey = Keypair.generate();
const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
const [configPda] = multisig.getProgramConfigPda({});
const config = await multisig.accounts.ProgramConfig.fromAccountAddress(conn, configPda);
console.log("squads creation fee (lamports):", config.multisigCreationFee.toString());

const sig = await multisig.rpc.multisigCreateV2({
  connection: conn, treasury: config.treasury, createKey, creator: payer, multisigPda,
  configAuthority: null, // autonomous: member changes need a threshold vote
  threshold, timeLock: 0, rentCollector: null,
  members: members.map((key) => ({ key, permissions: multisig.types.Permissions.all() })),
});
await conn.confirmTransaction(sig, "confirmed");

const [vault] = multisig.getVaultPda({ multisigPda, index: 0 });
const ms = await multisig.accounts.Multisig.fromAccountAddress(conn, multisigPda);
const out = { multisig: multisigPda.toBase58(), vault: vault.toBase58(), threshold: ms.threshold,
  members: ms.members.map((m) => m.key.toBase58()), tx: sig };
writeFileSync(`squads-${NET}.json`, JSON.stringify(out, null, 2));
console.log(out);
