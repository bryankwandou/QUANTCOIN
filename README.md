# QuantCoin (QC)

A Solana Token-2022 token whose long-term balances sit in a **hybrid quantum
vault**: a Pinocchio program that releases funds only when two signatures are
present, one classical (Ed25519) and one hash-based (Winternitz one-time
signature over SHA-256).

Status: **pre-audit. Live on devnet only.** Earlier versions of this repo
claimed a live mainnet, 1 trillion TPS and audit certificates. None of those
existed. They were removed (they remain in git history, commit "archive: …").

## What is and is not quantum-resistant

| Where QC is held | Protected by | Survives Shor's algorithm? |
|---|---|---|
| Normal wallet (Phantom, exchanges) | Ed25519 | **No**, and no token can change that; it depends on Solana itself |
| Hybrid vault | Ed25519 **and** Winternitz/SHA-256 | **Yes**: the hash half still holds |

Before quantum computers exist, the Ed25519 half also covers any bug in the
newer Winternitz code. An attacker has to break both halves.

## Devnet deployment (2026-09-23)

| | Address |
|---|---|
| Vault program | `CiupyGrAtWomKW5rDWbaMEsm3Db8pY8NPECgL2FfACms` (deploy cost 0.0376 SOL) |
| QC mint | `BUoNsFbNU5hxYK5rRoiHkFqonaoaNL836Wo5QgrukAK8` (genesis cost 0.0041 SOL) |
| Genesis vault (spent) | `Bfs2aWwiippbnT2qb6jWQzAsXs2qC7cmvcXrDRHXwkdU` |

Verified on devnet: mint and freeze authority not set, metadata update
authority disabled, supply 22T. A real spend (`Np26Uxfw…`) sent 1,000,000
QC out, moved 21,999,999,000,000 QC into a fresh vault and closed the old
one, using 610,076 CU. This also shows the TypeScript and Rust WOTS code
agree.

## Design

**Token (no custom program):** Token-2022 mint, 5 decimals, fixed supply of
22,000,000,000,000 QC. The extensions are MetadataPointer and TokenMetadata
only. After genesis the mint, freeze and metadata authorities are all
revoked. An authority held by an Ed25519 key is a quantum backdoor, so none
remain.

**Genesis:** the whole supply is minted straight into a hybrid vault, so no
Ed25519-only key ever holds it.

**Vault program** (`programs/qc-vault`, Pinocchio, stateless, one instruction):

- Vault address = PDA `["qcv", wots_pk_hash, owner_ed25519]`. Nothing is
  stored on-chain.
- `Spend` checks that the owner signed, recomputes the Winternitz public key
  from the signature and derives the PDA from it. It then sends `amount` to
  the destination and the remainder to a refund account (normally the
  owner's *next* vault), and closes the vault's token account.
- The signed message binds program, vault, mint, destination, refund,
  rent receiver and amount. A relayer cannot redirect anything.
- Winternitz keys are one-time. Every spend drains the vault, so a key
  never signs twice.

WOTS parameters: w = 256, n = 192 bits, 24 message digits + 2 checksum digits
(26 chains, 624-byte signature). That gives ~96-bit post-quantum security
against Grover.

## Measured numbers

| | Value |
|---|---|
| Program binary | 6,872 bytes |
| Program deploy rent (`solana rent 6917`) | 0.0358 SOL (plus a temporary buffer of the same size, refunded) |
| Spend compute units | ~651k (request 1.4M) |
| Spend transaction size | 1,124 / 1,232 bytes |
| Tests (LiteSVM + real Token-2022) | 8/8 pass |

Everyday transfers are plain Token-2022 transfers (no hook, no fee), as
fast and cheap as any Solana token. The vault is for cold storage.

## Client

```bash
cd client && npm i
RPC_URL=… PAYER=path/to/keypair.json PROGRAM_ID=… npx tsx genesis.ts
RPC_URL=… PAYER=… PROGRAM_ID=… MINT=… FROM=genesis NEXT=treasury-2 DEST_OWNER=… AMOUNT=… npx tsx spend.ts
```

Vault secrets are written to `client/keys/` (git-ignored, plaintext). Move
them to encrypted offline storage. A vault marked `used` must never sign
again.

## Build and test

```bash
cargo build-sbf --manifest-path programs/qc-vault/Cargo.toml
cargo test --manifest-path programs/qc-vault/Cargo.toml --release
```

## Before mainnet

1. External audit of `programs/qc-vault`.
2. ~~Devnet run of the full genesis~~ done (`client/genesis.ts`, `client/spend.ts`).
3. Deploy, then `solana program set-upgrade-authority --final`. An upgrade
   authority is an Ed25519 key, and so a quantum backdoor.
4. Back up **both** keys of every vault. Losing either locks the funds forever.
