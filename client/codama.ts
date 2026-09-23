// Codama description of programs/qc-vault. Single source of truth for the
// IDL (idl/qc_vault.json) and the generated @solana/kit client (client/generated).
// Run: npx tsx codama.ts   — re-run whenever the Spend layout changes.
import { writeFileSync, mkdirSync } from "node:fs";
import {
  createFromRoot, rootNode, programNode, instructionNode, instructionAccountNode,
  instructionArgumentNode, errorNode, pdaNode, variablePdaSeedNode, constantPdaSeedNodeFromString,
  numberTypeNode, fixedSizeTypeNode, bytesTypeNode, publicKeyTypeNode, numberValueNode,
  publicKeyValueNode,
} from "codama";
import { renderVisitor } from "@codama/renderers-js";
import { fileURLToPath } from "node:url";

const PROGRAM_ID = "CiupyGrAtWomKW5rDWbaMEsm3Db8pY8NPECgL2FfACms";
const fixed = (n: number) => fixedSizeTypeNode(bytesTypeNode(), n);

const root = rootNode(
  programNode({
    name: "qcVault",
    publicKey: PROGRAM_ID,
    version: "1.0.0",
    docs: ["Hybrid quantum vault: Ed25519 owner + Winternitz (SHA-256) one-time key."],
    pdas: [
      pdaNode({
        name: "vault",
        docs: ['["qcv", wots_pk_hash, owner]'],
        seeds: [
          constantPdaSeedNodeFromString("utf8", "qcv"),
          variablePdaSeedNode("wotsPkHash", fixed(32)),
          variablePdaSeedNode("owner", publicKeyTypeNode()),
        ],
      }),
    ],
    instructions: [
      instructionNode({
        name: "spend",
        docs: ["Send `amount` to destination, the rest to refund (next vault), close the vault token account."],
        arguments: [
          instructionArgumentNode({ name: "discriminator", type: numberTypeNode("u8"),
            defaultValue: numberValueNode(0), defaultValueStrategy: "omitted" }),
          instructionArgumentNode({ name: "bump", type: numberTypeNode("u8") }),
          instructionArgumentNode({ name: "wotsSeed", type: fixed(16) }),
          instructionArgumentNode({ name: "amount", type: numberTypeNode("u64") }),
          instructionArgumentNode({ name: "wotsSignature", type: fixed(624), docs: ["26 chains x 24 bytes"] }),
        ],
        accounts: [
          instructionAccountNode({ name: "vault", isWritable: false, isSigner: false }),
          instructionAccountNode({ name: "vaultTokenAccount", isWritable: true, isSigner: false }),
          instructionAccountNode({ name: "mint", isWritable: false, isSigner: false }),
          instructionAccountNode({ name: "destination", isWritable: true, isSigner: false }),
          instructionAccountNode({ name: "refund", isWritable: true, isSigner: false,
            docs: ["Receives balance - amount; normally the next vault's token account"] }),
          instructionAccountNode({ name: "rentReceiver", isWritable: true, isSigner: false }),
          instructionAccountNode({ name: "tokenProgram", isWritable: false, isSigner: false,
            defaultValue: publicKeyValueNode("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "token2022") }),
          instructionAccountNode({ name: "owner", isWritable: false, isSigner: true }),
        ],
      }),
    ],
    errors: [
      errorNode({ name: "badInstruction", code: 1, message: "Malformed instruction data or account count" }),
      errorNode({ name: "badSignature", code: 2, message: "WOTS signature does not match the vault" }),
      errorNode({ name: "insufficientBalance", code: 3, message: "Amount exceeds vault balance" }),
      errorNode({ name: "notATokenAccount", code: 4, message: "Vault token account invalid" }),
      errorNode({ name: "badTokenProgram", code: 5, message: "Not the Token-2022 program" }),
      errorNode({ name: "duplicateAccount", code: 6, message: "Accounts must be distinct" }),
      errorNode({ name: "missingOwnerSignature", code: 7, message: "Owner (Ed25519) did not sign" }),
    ],
  }),
);

const codama = createFromRoot(root);
const idl = new URL("../idl/", import.meta.url);
mkdirSync(idl, { recursive: true });
writeFileSync(new URL("qc_vault.json", idl), codama.getJson());
await codama.accept(renderVisitor(fileURLToPath(new URL(".", import.meta.url)), { generatedFolder: "generated", importExtension: "ts", syncPackageJson: false }));
console.log("wrote idl/qc_vault.json and client/generated");
