# QuantCoin (QC) Whitepaper

Version 1.0 · 2026-09-24 · Status: devnet, pre-audit

## 1. Abstract

QuantCoin is a fixed-supply Solana Token-2022 token paired with a **hybrid
quantum vault**: an on-chain program that releases funds only when the owner
provides both a classical Ed25519 signature and a hash-based Winternitz
one-time signature (WOTS). Large, long-term balances such as the treasury,
team and reserve are held in these vaults, so they stay safe even if a future
quantum computer breaks Ed25519. Everyday transfers are ordinary Token-2022
transfers: fast, cheap and supported by every Solana wallet.

QC is a token on Solana, not its own blockchain. It does not claim to make
Solana quantum-safe. It makes **QC stored in vaults** quantum-safe.

## 2. The problem

Solana, Bitcoin and Ethereum accounts are secured by elliptic-curve
signatures (Ed25519 / secp256k1). Shor's algorithm on a large enough quantum
computer recovers a private key from its public key. Estimates for when such
a machine will exist range from 10 to 30+ years. The risk is "harvest now,
attack later": public keys that are on-chain today can be attacked the day
that capability arrives. Balances meant to be held for decades need
protection that does not rely on elliptic curves.

Hash-based signatures (the family behind NIST's SLH-DSA / SPHINCS+ and
XMSS/LMS) rely only on the security of a hash function. Grover's algorithm
gives only a square-root speedup against them, which makes them the most
conservative post-quantum choice.

## 3. Design

### 3.1 Token

| Property | Value |
|---|---|
| Standard | SPL Token-2022 |
| Supply | 22,000,000,000,000 QC, fixed |
| Decimals | 5 |
| Extensions | MetadataPointer, TokenMetadata |
| Mint authority | **None** (revoked at genesis) |
| Freeze authority | **None** |
| Metadata update authority | **None** |
| Transfer fee / hook | None: transfers are as fast and cheap as any SPL token |

Every authority would be an Ed25519 key, and so a quantum backdoor. None
remain. Nobody, including the founder, can mint, freeze or edit QC.

The whole supply was minted directly into a hybrid vault at genesis. No
Ed25519-only key ever held it.

### 3.2 Hybrid vault

Program: Pinocchio (no_std), 6,872 bytes, stateless, one instruction (`Spend`).

- Vault address = PDA of `["qcv", wots_public_key_hash, owner_ed25519]`. No
  account data is stored.
- `Spend` checks, in order:
  1. The owner's Ed25519 key signed the transaction.
  2. The WOTS public key recomputed from the signature derives this vault's
     address.
  3. The token program is Token-2022, the accounts are distinct, and the
     balance is enough.
- It then sends `amount` to the destination, sends the **entire remainder**
  to a refund account (normally the owner's next fresh vault) and closes the
  vault. Each WOTS key signs exactly once.
- The signed message binds program, vault, mint, destination, refund, rent
  receiver and amount. Nobody relaying the transaction can change any of
  them.

An attacker needs **both** keys. Before quantum computers exist, Ed25519
also covers any bug in the newer WOTS code. After they exist, the WOTS half
still holds.

### 3.3 WOTS parameters

| Parameter | Value |
|---|---|
| Hash | SHA-256 (`sol_sha256` syscall) |
| w | 256 |
| n | 192 bits |
| Chains | 24 message + 2 checksum = 26 |
| Signature | 624 bytes |
| Post-quantum security | ~96 bits (second preimage under Grover) |
| Domain separation | `QCV1/chain`, `QCV1/pk`, `QCV1/msg`, `QCV1/sk`, tweaked by seed, chain and step |

A spend transaction uses 1,124 of the 1,232-byte limit and ~610k compute
units (worst case ~1.09M of 1.4M).

### 3.4 What is and is not protected

| Where QC is held | Survives a quantum attacker? |
|---|---|
| Hybrid vault | **Yes** |
| Normal wallet, exchange, DEX pool | No. That depends on Solana itself |

If Solana later adds post-quantum accounts, QC works with them automatically,
because it is a standard Token-2022 mint.

## 4. Tokenomics

| Allocation | % | QC | Held in | Policy |
|---|---|---|---|---|
| Treasury / ecosystem | 45% | 9.9T | Hybrid vault | Grants, integrations, listings; every spend announced publicly |
| Liquidity | 20% | 4.4T | Hybrid vault | Paired on Raydium/Orca at launch; LP tokens burned |
| Airdrop / community | 15% | 3.3T | Hybrid vault | 3–4 waves to real users, with sybil filtering |
| Founder / team | 10% | 2.2T | Hybrid vault | Locked 12 months, then released monthly over 24 months (public commitment) |
| Reserve (audit, market making) | 10% | 2.2T | Hybrid vault | Audits, bug bounties, market maker |

All vault addresses are published (section 8). The program has no time-lock,
so the founder lock is a **public commitment**: anyone can watch the vault
address, and any spend before the date is visible on-chain.

No private sale. No presale. No inflation.

## 5. Utility

1. **Quantum Safe:** a web app where anyone creates a personal hybrid vault
   and moves their QC into it. This is the core product.
2. **Cold-storage standard:** DAOs and projects can hold QC treasuries in
   hybrid vaults.
3. **Ecosystem grants** from the treasury for wallets, explorers and dApps
   that integrate the vault ([docs/INTEGRATION.md](docs/INTEGRATION.md)).
4. **Later:** a generic hybrid vault for any Token-2022 mint (same design,
   parameterised by mint).

## 6. Security

- Internal audit and live devnet attack run: 12/12 local tests pass and
  13/13 on-chain attacks were blocked ([audit/AUDIT.md](audit/AUDIT.md)).
- **An external audit is required before mainnet.**
- The mainnet program is deployed with `--final` (not upgradeable). No admin
  key exists anywhere in the system.
- Known limits: a spent vault's address must never receive funds again
  (AUDIT F3), and vault owners must only sign spends built by their own
  client (F4).

## 7. Roadmap

| Phase | Deliverable | Status |
|---|---|---|
| 0 | Program, tests, devnet genesis, internal audit, Codama client | Done |
| 1 | Allocation vaults on devnet, whitepaper, integration guide | Done |
| 2 | External audit and fixes | Next |
| 3 | Mainnet: program `--final`, genesis, allocations, liquidity | After audit |
| 4 | Quantum Safe web app, airdrop wave 1 | |
| 5 | Wallet and explorer integrations, grants program | |
| 6 | Generic hybrid vault for any Token-2022 mint | Research |

No dates are promised before the audit.

## 8. Addresses (devnet)

| | Address |
|---|---|
| Vault program | `CiupyGrAtWomKW5rDWbaMEsm3Db8pY8NPECgL2FfACms` |
| QC mint | `BUoNsFbNU5hxYK5rRoiHkFqonaoaNL836Wo5QgrukAK8` |
| Treasury vault | `4JKL7XW85FpAD8cu5jE2ZQHWQ5duhrv2LaCpQPxW3381` |
| Founder vault | `7x8zcyKjwEsumvkkRQRtSNizuWUMCi1AsUSre4vjLLh6` |
| Liquidity vault | `5XQwp25eTH3GoyewvrifzjfTzyKtYKBDzNyrpveX7wqG` |
| Airdrop vault | `BxnfUURSJxChjWUDSDE46Not5Bp8Z7ZJr3sykL8EWqTw` |
| Reserve vault | `4wdqvoXevFCoAnSKPUJBKA33DDjszqFh383z7XpxiTSn` |

Mainnet addresses will be different and published at launch.

## 9. Risks

QC has no guaranteed value, and most new tokens lose most of their value.
The program is unaudited until phase 2. Losing either key of a vault locks
those funds forever. Quantum timelines are uncertain. Nothing in this
document is investment advice.
