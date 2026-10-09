# QuantCoin: internal security audit (canonical status)

This file is the one current security baseline for QuantCoin. Older reports
(`AUDIT.md` of 2026-09-23, `AUDIT-MAINNET-2026-10-03.md`, the test evidence
files) are kept unchanged as history. Where they disagree with this file,
this file is current.

## Status

**Maintainer-performed internal security review. Release gate: OPEN.**

- Not an independent audit and not a third-party certification.
- The R-1 fix (canonical vault bump) is live on mainnet since
  2026-10-07 12:35:09 UTC (slot 454224541), deployed through Squads
  proposal #4, transaction
  `UgtLiMZHS8XiVJAAF587Y4B3SEEs3H2SVnvQmqxZDqaso3DCwfvcvDEB8v8UfhXCWSpjaCCqjDk828J4r7Yqh7P`.
- R-A (payee memo freeze) is bounded by client checks on this release; the
  program-level fix is ready on branch `fix/memo-cpi` but does not fit the
  deployed program's size without an extension the project cannot fund yet.

Last verified: 2026-10-09 17:11 UTC (slot 454937263).

## Release identity

| | Live on mainnet now (since 2026-10-07) | Previous binary (2026-10-02 to 2026-10-07) |
|---|---|---|
| Program | `CiupyGrAtWomKW5rDWbaMEsm3Db8pY8NPECgL2FfACms` | same program |
| Source | `programs/qc-vault` at commit `08f53d5` (`main`) | `programs/qc-vault` at commit `344c2a5` (unchanged through `acb36f8`) |
| Binary SHA-256 | `4d209e485742abbcd7a52ece3f142eba72dda44314c8dbde2216ee5515dd474e` (7,464 B, fills the account exactly) | `07e6b6dd45e6bb7f26ef4ce85f1e6168f8dd1b4bde2b0f4979a5fad6769194be` (7,456 B) |
| Deployed | 2026-10-07 12:35:09 UTC, slot 454224541, Squads proposal #4 | 2026-10-02 |
| Upgrade authority | Squads v4 2-of-3 `A9tdTp68GVvGVLherFjDUgJptoHMWja5r4uWH5DFou2P`, vault `45nAvRrgqxkdnsDmW9dmukHNcxE1TM5PnJsH27cTXxez`, time lock 86,400 s | same |

Earlier hashes in other documents belong to earlier builds:
`0462c658…730b` (devnet genesis build, 2026-09-23), `93abe8ef…9b2e`
(first mainnet deploy, 2026-09-30, replaced on 2026-10-02 because a
hard-coded rent value broke spends to fresh rent receivers), `07e6b6dd…94be`
(2026-10-02, replaced on 2026-10-07 by the R-1 fix).

How the live hash was checked (2026-10-09):

```bash
solana program show -um CiupyGrAtWomKW5rDWbaMEsm3Db8pY8NPECgL2FfACms   # Last Deployed In Slot: 454224541
solana program dump -um CiupyGrAtWomKW5rDWbaMEsm3Db8pY8NPECgL2FfACms onchain.so
sha256sum onchain.so                    # 4d209e48…474e, no padding: the binary is 7,464 B
git checkout 08f53d5 && cargo build-sbf --manifest-path programs/qc-vault/Cargo.toml
sha256sum target/deploy/qc_vault.so     # 4d209e48…474e, identical (clean worktree rebuild 2026-10-06)
```

Tests on the release candidate:

```bash
cargo build-sbf --manifest-path programs/qc-vault/Cargo.toml
cargo test --manifest-path programs/qc-vault/Cargo.toml --release
```

## Release gate

The release counts as "internal security audit completed" only when every
line below is true. Today one is not.

| Gate | State |
|---|---|
| Canonical-bump fix (R-1) is in the deployed binary | Yes, since 2026-10-07 (Squads proposal #4) |
| Memo freeze (R-A) fixed or explicitly bounded | Bounded: clients refuse memo-required recipients before signing; program fix pending (see R-A) |
| Deployed hash recomputed from the chain and tied to a commit | Yes: `4d209e48…474e` = commit `08f53d5` (above) |
| Vault and multisig keys in encrypted offline storage | **No** (F5 / Q-1) |
| Upgrade authority documented as it is | Yes (above) |
| Adversarial tests pass on the release commit | Yes: 29/29 on 2026-10-05 (`vault.rs` 15, `fuzz.rs` 14, release profile) |
| Release candidate deployed and re-verified by hash | Yes: deployed 2026-10-07, re-verified 2026-10-09 |

## Scope

Reviewed: `programs/qc-vault/src/lib.rs` and `wots.rs` (WOTS recovery and
checksum, PDA derivation, owner signature, digest construction and field
binding, destination/refund/rent binding, Token-2022 and system program
pinning, vault ATA binding, one-time spent marker, close and rent
handling), the spend builders and pre-sign checks in `client/qc.ts`,
`app/src/lib/vault.ts` and `apps/native/lib/send.dart`, and the mainnet
deployment (program bytes, mint authorities, multisig).

Outside the scope of this protocol review: the Solana runtime and the
Token-2022, ATA, Memo and Squads programs. Assumptions made about them:
Token-2022 enforces ownership, mint and authority on `TransferChecked` and
`CloseAccount`; the QC mint has no transfer hook, transfer fee or permanent
delegate and its authorities are revoked (checked on chain); a Token-2022
account owner can switch on "require incoming memos" at any time.

## Findings register

Nothing is removed from this list. States: FIXED, VERIFIED ON CURRENT
RELEASE, ACCEPTED RISK, DOCUMENTED DESIGN PROPERTY, OPEN — RELEASE BLOCKER,
OPEN — NON-BLOCKING FOLLOW-UP.

| ID | Finding | Severity | State |
|---|---|---|---|
| R-1 | Caller-chosen PDA bump: one WOTS key could guard several vault addresses, and the per-address spent marker would let it sign twice (was I-1, raised 2026-10-04 in PR #1) | Medium (needs the owner's Ed25519 key too; both clients only derive the canonical bump) | FIXED on mainnet 2026-10-07 (Squads proposal #4, tx `UgtLiMZH…Yqh7P`); VERIFIED ON CURRENT RELEASE. Test `rejects_noncanonical_bump_wots_key_reuse` |
| R-A | A payee that turns on Token-2022 "require incoming memos" makes the signed spend fail; the client has already recorded the digest, so the balance waits until the payee turns it off (PR #13) | Medium for wallets that pay third parties | **OPEN — RELEASE BLOCKER**, bounded: `checkSpend` in `client/qc.ts` and `send.dart` refuse such recipients before signing. Remaining gap: a payee who switches it on between that check and the transaction. Program fix (memo CPI before each transfer, optional 10th account) on branch `fix/memo-cpi`, 8,072 B, needs a program extension. Test `memo_required_payee_blocks_spend_known_limitation` |
| F5 / Q-1 | Vault secrets and multisig member keys are stored in plaintext on the operator machine | High (operational) | **OPEN — RELEASE BLOCKER** |
| Q-2 | While upgradeable, every vault is only as quantum-safe as the Ed25519 multisig keys | High | DOCUMENTED DESIGN PROPERTY until the program is made final |
| F6 | Upgrade authority | — | VERIFIED ON CURRENT RELEASE: Squads 2-of-3, 24 h time lock |
| Q-3 | Squads time lock was 0 | Medium | FIXED 2026-10-03 |
| M-1 | Signature replay against a token account created after the spend | High | FIXED (on-chain spent marker); VERIFIED ON CURRENT RELEASE |
| F9 | Spend aimed at a decoy token account owned by the PDA | Medium | FIXED (vault ATA required); VERIFIED ON CURRENT RELEASE |
| F1 | Negative tests passed for the wrong reason | Test quality | FIXED |
| F2 | Failed broadcast could lock a vault | High (client) | FIXED (retry of the same digest allowed) |
| F3 | Tokens sent to a spent vault are locked | Low | DOCUMENTED DESIGN PROPERTY; clients refuse spent vaults as recipients |
| F4 | 192-bit message digest, ~2⁶⁴ quantum collision cost | Low | ACCEPTED RISK |
| F7 | Unchecked reads of mint and token account data | Info | VERIFIED: a fake account only yields a fake balance that the Token-2022 CPI then rejects |
| F8 | Compute headroom | Info | VERIFIED: worst case ~1.09 M of 1.4 M CU |
| I-2 | Arbitrary Token-2022 mints (permanent delegate, transfer hook, transfer fee), see also PR #15 | Info | DOCUMENTED DESIGN PROPERTY: the vault is built for the QC mint only |
| I-3 | Entrypoint comment said eight accounts | Info | FIXED in `08f53d5` |
| Q-4 | Site RPC proxy open relay | Low | Mitigated (origin allowlist); keyed upstream is the follow-up |
| Q-5 | Dependency advisories (astro, bigint-buffer) | Low | OPEN — NON-BLOCKING FOLLOW-UP |
| Q-6 | Pool fees claimable by a hot wallet | Low | FIXED: 2.62 SOL moved to the Squads vault |
| MT-1 | Mutation testing left 9 of 29 mutants alive (PR #14) | Test quality | OPEN — NON-BLOCKING FOLLOW-UP: add tests that kill them |

## Evidence

| Evidence | File |
|---|---|
| 13 live attacks on the mainnet treasury vault, each rejected with the expected code | `audit/mainnet-attack-run.json` |
| Program suite on a mainnet fork | `audit/INTERNAL-TEST-EVIDENCE-2026-10-04.md` |
| Devnet attack run | `audit/devnet-attack-run.json` |
| Program unit, adversarial and fuzz tests | `programs/qc-vault/tests/` |

Reports in open pull requests (property tests, static analysis, mutation
testing, Token-2022 hostile extensions, digest binding) were posted by the
maintainer and have no GitHub reviewer. Their results are counted here only
where a test in `main` reproduces them.
