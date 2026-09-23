// Genesis: Token-2022 mint (MetadataPointer + TokenMetadata), full supply into
// a hybrid vault, then every authority revoked.
// Env: RPC_URL, PAYER (keypair file), PROGRAM_ID.
import { Keypair, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  AuthorityType, ExtensionType, TOKEN_2022_PROGRAM_ID, LENGTH_SIZE, TYPE_SIZE,
  createAssociatedTokenAccountIdempotentInstruction, createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction, createMintToCheckedInstruction, createSetAuthorityInstruction,
  getMintLen,
} from "@solana/spl-token";
import { createInitializeInstruction, createUpdateAuthorityInstruction, pack, type TokenMetadata } from "@solana/spl-token-metadata";
import { writeFileSync } from "node:fs";
import { env, newVault, vaultAddress, vaultTokenAccount } from "./qc.ts";

const DECIMALS = 5;
const SUPPLY = 22_000_000_000_000n * 10n ** BigInt(DECIMALS);

const { conn, payer, program } = env();
const mintKp = Keypair.generate();
const mint = mintKp.publicKey;
const meta: TokenMetadata = {
  mint, updateAuthority: payer.publicKey,
  name: "QuantCoin", symbol: "QC", uri: "", additionalMetadata: [["vault", "hybrid Ed25519 + WOTS"]],
};

const start = await conn.getBalance(payer.publicKey);
const mintLen = getMintLen([ExtensionType.MetadataPointer]);
const metaLen = TYPE_SIZE + LENGTH_SIZE + pack(meta).length;
const lamports = await conn.getMinimumBalanceForRentExemption(mintLen + metaLen);

const treasury = newVault("genesis");
const [pda] = vaultAddress(program, treasury);
const ta = vaultTokenAccount(program, mint, treasury);

const tx1 = new Transaction().add(
  SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint, space: mintLen, lamports, programId: TOKEN_2022_PROGRAM_ID }),
  createInitializeMetadataPointerInstruction(mint, payer.publicKey, mint, TOKEN_2022_PROGRAM_ID),
  createInitializeMintInstruction(mint, DECIMALS, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
  createInitializeInstruction({ programId: TOKEN_2022_PROGRAM_ID, metadata: mint, updateAuthority: payer.publicKey,
    mint, mintAuthority: payer.publicKey, name: meta.name, symbol: meta.symbol, uri: meta.uri }),
);
const s1 = await sendAndConfirmTransaction(conn, tx1, [payer, mintKp]);
console.log("mint created", mint.toBase58(), s1);

const tx2 = new Transaction().add(
  createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ta, pda, mint, TOKEN_2022_PROGRAM_ID),
  createMintToCheckedInstruction(mint, ta, payer.publicKey, SUPPLY, DECIMALS, [], TOKEN_2022_PROGRAM_ID),
  // Revoke everything an Ed25519 key could abuse after a quantum break.
  createSetAuthorityInstruction(mint, payer.publicKey, AuthorityType.MintTokens, null, [], TOKEN_2022_PROGRAM_ID),
  createSetAuthorityInstruction(mint, payer.publicKey, AuthorityType.MetadataPointer, null, [], TOKEN_2022_PROGRAM_ID),
  createUpdateAuthorityInstruction({ programId: TOKEN_2022_PROGRAM_ID, metadata: mint, oldAuthority: payer.publicKey, newAuthority: null }),
);
const s2 = await sendAndConfirmTransaction(conn, tx2, [payer]);
console.log("supply minted to vault + authorities revoked", s2);

const cost = (start - (await conn.getBalance(payer.publicKey))) / 1e9;
const out = { mint: mint.toBase58(), program: program.toBase58(), vault: pda.toBase58(), vaultTokenAccount: ta.toBase58(),
  supply: SUPPLY.toString(), decimals: DECIMALS, txs: [s1, s2], costSol: cost };
writeFileSync(new URL("./genesis.json", import.meta.url), JSON.stringify(out, null, 2));
console.log(out);
