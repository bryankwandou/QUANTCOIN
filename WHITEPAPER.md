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

Program: Pinocchio (no_std), 7,456 bytes, stateless, one instruction (`Spend`).

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

Mainnet allocation, executed 2026-09-29 (`client/allocations-mainnet.json`):

| Allocation | % | QC | Held in | Policy |
|---|---|---|---|---|
| Treasury / ecosystem | 35% | 7.7T | Hybrid vault | Grants, integrations, listings; every spend announced publicly |
| Liquidity | 20% | 4.4T | Hybrid vault | 22B QC (0.1% of supply) in a single-sided Meteora DAMM v2 pool opening at 500 SOL for the whole supply, liquidity permanently locked; the rest stays in the vault |
| Airdrop / community | 15% | 3.3T | Hybrid vault | 3–4 waves to real users, with sybil filtering |
| Founder / team | 20% | 4.4T | 5% in the founder wallet, 15% in 3 hybrid vaults | See "Changes" below |
| Reserve (audit, market making) | 10% | 2.2T | Hybrid vault | Audits, bug bounties, market maker |

All vault addresses are published (section 8). The program has no time-lock,
so any founder policy is a commitment, not code: every vault movement is
visible on-chain.

No private sale. No presale. No inflation.

### Changes to this section

- **2026-09-24 (first version):** founder/team 10% (2.2T) in one vault,
  locked until 2027-09-24, then released monthly over 24 months; treasury 45%.
- **2026-09-29, at mainnet genesis:** the founder share was raised to 20%,
  split into four 5% vaults, and the treasury reduced to 35%. This document
  was not updated at the time; it was corrected on 2026-10-02.
- **2026-10-02:** founder vault 1 (1.1T QC, 5% of supply) was spent to the
  founder's wallet `ETcQvsQek2w9feLfsqoe4AypCWfnrSwQiv3djqocaP2m`
  (txs `28qiAZiGZ8p5MjypoYz35Y96NJfKejhNh9BnGzShESRPTSpxCmdksmwF8JQVMJenMFWG4KPWeudpyCF3C8WXN9wh`,
  `5NvE815GDStsYGtGEoyyAxZLoWDKCaRJeo9yZc59ydT5L9dLjahEjcrGAJqhzpdkrD1dNEhCYs1DxEsEhk8VGf7W`).
  This broke the 2027-09-24 lock published in the first version. A return
  to a new founder vault 1r (`BV9UN38mVz1ndKsRunNMwi5nE3MGUVgBf2hm6jNQbV4T`)
  was announced the same day, then cancelled by the founder: **this 5% stays
  in the founder wallet and is not locked.** Vault 1r was created but is
  empty and unused.
- Founder vaults 2–4 (3.3T QC, 15%) **stay locked until 2027-09-24**, the
  date of the original commitment. They have not moved. Any later release
  is announced publicly before the spend.

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

- Internal audit, live devnet and mainnet attack runs; 27 local tests and a
  1,633-case mainnet-fork suite pass ([audit/AUDIT.md](audit/AUDIT.md)).
- **No external audit yet.** Mainnet launched on 2026-09-29 before one,
  which differs from the earlier plan of auditing first.
- The program is upgradeable. The upgrade authority is a Squads 2-of-3
  multisig (vault `45nAvRrgqxkdnsDmW9dmukHNcxE1TM5PnJsH27cTXxez`); the plan
  is to set it `--final` after the external audit. It was upgraded once,
  on 2026-10-02, to read the Rent sysvar instead of a hard-coded value.
  Since 2026-10-03 the multisig has a 24-hour time lock: an approved
  upgrade waits a day before it can run (tx `whoiuHmoWetoYcRQqgbTq9KfZkfdyVEEGjq9e2wLna7wHGazRi8ASTR2PeyLqRbJuQtxYitWLiD4hXMXEjH3vtw`).
- Known limits: a spent vault's address must never receive funds again
  (AUDIT F3), and vault owners must only sign spends built by their own
  client (F4).

## 7. Roadmap

| Phase | Deliverable | Status |
|---|---|---|
| 0 | Program, tests, devnet genesis, internal audit, Codama client | Done |
| 1 | Allocation vaults on devnet, whitepaper, integration guide | Done |
| 2 | Mainnet: program (upgradeable, Squads 2-of-3), genesis, allocations | Done 2026-09-29 |
| 3 | Liquidity pool on Meteora DAMM v2 (opened before the external audit) | In progress |
| 3b | External audit, then `--final` | Next |
| 4 | Quantum Safe web app, airdrop wave 1 | |
| 5 | Wallet and explorer integrations, grants program | |
| 6 | Generic hybrid vault for any Token-2022 mint | Research |

No further dates are promised before the audit.

## 8. Addresses (mainnet)

| | Address |
|---|---|
| Vault program | `CiupyGrAtWomKW5rDWbaMEsm3Db8pY8NPECgL2FfACms` |
| QC mint | `AsEEaydVYMpghdNTrQoVZTAhJSewZT5xD9WE9hpA68W2` |
| Treasury vault | `Hh8dMAjFfYEdfcj2xnT3s52DonzFL2gt5KEUDVezvA2h` |
| Founder vault 1 (spent 2026-10-02) | `8Hzt3hHCDup7pP8rZ1MzFesBjpWbSsaLxFrRSAD1hMjq` |
| Founder vault 1r (created, unused, empty) | `BV9UN38mVz1ndKsRunNMwi5nE3MGUVgBf2hm6jNQbV4T` |
| Founder wallet (holds founder share 1, 5%) | `ETcQvsQek2w9feLfsqoe4AypCWfnrSwQiv3djqocaP2m` |
| Founder vault 2 | `7kCLSt2e16CDcJ5K8JYTcsPoFH2hEThYv31r4M9su9yz` |
| Founder vault 3 | `5fRw2g2B7tbX7pGyexT5rxDs8FAkrzurbhZGQHnY9EYG` |
| Founder vault 4 | `8Q89eH2bJNc8khbv3A6kqZXPukdPzeGzt2GpD1FSvDHd` |
| Liquidity vault (spent 2026-10-02: 22B QC to the pool) | `9RA4EPJ3zPwnPeUFJZEzTw7NDJZWUewmJykzWHFKnkyx` |
| Liquidity vault 2 (holds the remaining 4.378T QC) | `3DquQtE2ikqGRy5bvZiTDTiPnuKr3jFVvogLC2TpxdRL` |
| QC/SOL pool (Meteora DAMM v2, opens 2026-10-02 15:30 UTC (22:30 WIB)) | `AyS1vByiVFsVdsekRZE1mGVY5MHY1YMs59DeGwDwbbwB` |
| Airdrop vault | `9JhPWgx96ckNUqBRERww5pzQF5aqpb2Qu6SnJkBgRR6T` |
| Reserve vault | `3S8oyyPGcz45ETbs7PFrdZ7V8QTKdQUpzySMiESybx93` |

Devnet addresses (test deployment, 10% founder split) are in
`audit/allocations-devnet.json`.

Launch commitments and runbook: [docs/LAUNCH.md](docs/LAUNCH.md).

## 9. Risks

QC has no guaranteed value, and most new tokens lose most of their value.
The program has no external audit yet. Losing either key of a vault locks
those funds forever. Quantum timelines are uncertain. Nothing in this
document is investment advice.
