// Local only. Pre-signs the ONE treasury spend the cloud bench starts with, so the cloud gets
// treasury-9's owner key + this signature but never its WOTS master: the pair authorises
// exactly "11 base units to bench-ra-c1, the rest to treasury-10" and nothing else.
// treasury-10's keys stay on this machine. Bench vault keys (worthless) are copied out.
// Env: QC_NET=mainnet, QC_KEYDIR, RPC_URL, PAYER (deployer), PROGRAM_ID, MINT, OUT, PARALLEL (10).
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { publicKeyHash, checkSpend, env, loadVault, newVault, spendIxs, vaultAddress, vaultExists, vaultTokenAccount } from "./qc.ts";

const { conn, payer, program } = env();
const mint = new PublicKey(process.env.MINT!), P = Number(process.env.PARALLEL ?? 10), OUT = process.env.OUT!;
const get = (n: string) => (vaultExists(n) ? loadVault(n) : newVault(n));
const t9 = loadVault("treasury-9"), t10 = get("treasury-10");
const chain = Array.from({ length: P + 1 }, (_, i) => get(`bench-ra-c${i + 1}`));
const par = Array.from({ length: P }, (_, i) => get(`bench-ra-p${i + 1}`));
const destOwner = vaultAddress(program, chain[0])[0];
await checkSpend(conn, program, mint, t9, destOwner, BigInt(P + 1), t10, payer.publicKey);
const ixs = spendIxs(program, mint, t9, getAssociatedTokenAddressSync(mint, destOwner, true, TOKEN_2022_PROGRAM_ID),
  vaultTokenAccount(program, mint, t10), payer.publicKey, BigInt(P + 1));
const presig = Buffer.from(ixs[1].data.subarray(2 + 16 + 8)).toString("hex");
const j = JSON.parse(readFileSync(join(process.env.QC_KEYDIR!, "vault-treasury-9.json"), "utf8"));
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/treasury-9.secret.json`, JSON.stringify({ owner: j.owner, master: "", seed: j.seed, used: true, signed: j.signed, presig, pkHash: publicKeyHash(t9.master, t9.seed).toString("hex") }));
// treasury-10: address only (as a key file with no secrets would be misleading, write its pubkeys).
for (const v of [...chain, ...par]) writeFileSync(`${OUT}/vault-${v.name}.json`, readFileSync(join(process.env.QC_KEYDIR!, `vault-${v.name}.json`)));
console.log({ signedDigest: j.signed, sigBytes: presig.length / 2, treasury10Vault: vaultAddress(program, t10)[0].toBase58(),
  treasury10TokenAccount: vaultTokenAccount(program, mint, t10).toBase58(), benchHead: destOwner.toBase58() });
