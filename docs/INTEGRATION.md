# Integrating QuantCoin

For wallets, explorers, DEXs and dApp developers.

## 1. QC as a normal token (no extra work)

QC is a standard Token-2022 mint with no transfer fee and no hook. Anything
that supports Token-2022 already supports QC:

- Transfers: `transferChecked` with `TOKEN_2022_PROGRAM_ID`, 5 decimals.
- Token account: the associated token account under Token-2022.
- Name, symbol and logo come from on-chain TokenMetadata (the
  MetadataPointer points at the mint itself).
- DEX pools: Raydium CPMM and Orca Whirlpools support Token-2022 mints that
  have no transfer hook.

## 2. Reading vaults

A vault is a PDA with no data. Its QC sits in the vault's associated token
account (Token-2022, `allowOwnerOffCurve = true`).

```ts
import { findVaultPda } from "../client/generated";          // Codama client
const [vault] = await findVaultPda({ wotsPkHash, owner });    // seeds: "qcv", pk hash, owner
```

Explorers: label any token account owned by a vault PDA as "QC hybrid vault
(quantum-resistant)". A closed vault token account means the vault is
**spent**. Never show a spent vault as a deposit address (AUDIT F3).

## 3. Building a spend (wallets)

Use the Codama client for the instruction layout and `client/qc.ts` for the
WOTS signature:

```ts
import { spendDigest, sign } from "../client/qc";
import { getSpendInstruction } from "../client/generated";

const digest = spendDigest(program, vault, mint, dest, refund, rentTo, amount);
const wotsSignature = sign(master, seed, digest);   // ONE message per key, ever
const ix = getSpendInstruction({ vault, vaultTokenAccount, mint, destination: dest,
  refund, rentReceiver: rentTo, owner, bump, wotsSeed: seed, amount, wotsSignature });
```

Rules a wallet MUST enforce:

1. Store the signed digest before broadcasting. Re-sign only that same
   digest (a safe retry); refuse any other message for that key.
2. `refund` should be a freshly generated vault owned by the same user.
3. Request 1,400,000 compute units.
4. Keep both secrets (Ed25519 key, WOTS master + seed) encrypted. Losing
   either locks the vault.
5. Never sign a spend built by a third party.

## 4. Error codes

| Code | Name | Meaning |
|---|---|---|
| 1 | BadInstruction | Malformed instruction data |
| 2 | BadSignature | WOTS signature, PDA or message binding does not match |
| 3 | InsufficientBalance | Amount above the vault balance |
| 4 | NotATokenAccount | Vault token account missing (already spent) |
| 5 | BadTokenProgram | Not Token-2022 |
| 6 | DuplicateAccount | Accounts must be distinct |
| 7 | MissingOwnerSignature | The Ed25519 owner did not sign |

Full IDL: `idl/qc_vault.json`. Generate clients for other languages with any
Codama renderer from `client/codama.ts`.

## 5. Scripts

| Script | Purpose |
|---|---|
| `client/genesis.ts` | Create the mint, mint the full supply into a vault, revoke all authorities |
| `client/allocate.ts` | Split the treasury into founder / liquidity / airdrop / reserve vaults |
| `client/spend.ts` | Spend from a vault to any wallet |
| `client/audit-devnet.ts` | Run the live attack suite against a deployment |

## 6. Integration checklist

| Integration | Needs | Effort |
|---|---|---|
| Wallet shows QC balance | Token-2022 support | None |
| Explorer labels vaults | Section 2 | Small |
| DEX pool | Token-2022 pool type | None |
| Wallet creates and spends vaults | Sections 3 and 4 | Medium |
| Airdrop tool | Pay out from the airdrop vault via spends | Small |

Grants for integrations come from the treasury vault (WHITEPAPER §5).
