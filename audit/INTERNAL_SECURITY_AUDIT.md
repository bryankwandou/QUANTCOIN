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
- The R-A fix (memo CPI before each transfer) went live on 2026-10-11
  through Squads proposal #7 (binary `dd3495ee…4acb`).
- The live binary is the same program rebuilt as SBPF v3 (`51f64e1a…be62`),
  deployed 2026-10-18 06:34 UTC (slot 458336425) through Squads proposal #8,
  transaction
  `3QFgw1utfbBNdEmTEd5byyPvCi8m1WXKt9y6GtXWqSPwiHcc4ioHpjQegnTffjwWF9Ki5DJCDkRKFPQzAjRYoUh7`.

Last verified: 2026-10-18 06:35 UTC (slot 458336425).

### Check it yourself (one command)

```bash
git clone https://github.com/bryankwandou/QUANTCOIN && cd QUANTCOIN
bash audit/verify.sh             # rebuild, compare with the live mainnet binary, run all tests (~5 min)
bash audit/verify.sh --mutants   # also re-run the 9 MT-1 mutants (~30 min)
```

Needs the Solana CLI (Agave 2.x, `cargo build-sbf`) and Rust. The script
prints PASS/FAIL per step and exits non-zero on any failure. Maintainer run
of 2026-10-18 at commit `982f406`: `audit/verify-run-2026-10-18.txt` (all
checks passed; vault 23/23, fuzz 14/14).

What this does not cover: key custody (F5 / Q-1, the one open gate below)
cannot be shown by a script, and none of this is an independent audit.

## Release identity

| | Live on mainnet now (since 2026-10-18) | Previous binary (2026-10-11 to 2026-10-18) |
|---|---|---|
| Program | `CiupyGrAtWomKW5rDWbaMEsm3Db8pY8NPECgL2FfACms` | same program |
| Source | `programs/qc-vault` at commit `d3cc437` (`main`), built with `cargo build-sbf --arch v3`; clean-checkout rebuild on 2026-10-18 gives the same hash | R-A source (branch `upgrade/r-a`, commit `184c7bd`), SBPF v0 |
| Binary SHA-256 | `51f64e1a81de78056e886f0d9f55855f56f9e149fb612f9f5f328a8a9100be62` (6,760 B, SBPF v3) | `dd3495ee…4acb` (8,072 B) |
| Deployed | 2026-10-18 06:34 UTC, slot 458336425, Squads proposal #8 | 2026-10-11, Squads proposal #7 |
| Upgrade authority | Squads v4 2-of-3 `A9tdTp68GVvGVLherFjDUgJptoHMWja5r4uWH5DFou2P`, vault `45nAvRrgqxkdnsDmW9dmukHNcxE1TM5PnJsH27cTXxez`, time lock 86,400 s | same |

Earlier hashes in other documents belong to earlier builds:
`0462c658…730b` (first test build, 2026-09-23), `93abe8ef…9b2e`
(first mainnet deploy, 2026-09-30, replaced on 2026-10-02 because a
hard-coded rent value broke spends to fresh rent receivers), `07e6b6dd…94be`
(2026-10-02, replaced on 2026-10-07 by the R-1 fix), `4d209e48…474e`
(R-1 fix, commit `08f53d5`, replaced on 2026-10-11 by R-A), `dd3495ee…4acb`
(R-A, replaced on 2026-10-18 by the SBPF v3 build).

How the live hash was checked (2026-10-18):

```bash
solana program show -um CiupyGrAtWomKW5rDWbaMEsm3Db8pY8NPECgL2FfACms   # Last Deployed In Slot: 458336425
solana program dump -um CiupyGrAtWomKW5rDWbaMEsm3Db8pY8NPECgL2FfACms onchain.so
head -c 6760 onchain.so | sha256sum     # 51f64e1a…be62 (account is larger; the rest is zero padding)
cargo build-sbf --arch v3 --manifest-path programs/qc-vault/Cargo.toml
sha256sum target/deploy/qc_vault.so     # 51f64e1a…be62
```

Tests on the release candidate:

```bash
cargo build-sbf --arch v3 --manifest-path programs/qc-vault/Cargo.toml
cargo test --manifest-path programs/qc-vault/Cargo.toml --release
```

## Release gate

The release counts as "internal security audit completed" only when every
line below is true. Today one is not.

| Gate | State |
|---|---|
| Canonical-bump fix (R-1) is in the deployed binary | Yes, since 2026-10-07 (Squads proposal #4) |
| Memo freeze (R-A) fixed or explicitly bounded | Yes: program fix live since 2026-10-11 (Squads proposal #7), kept in the v3 build |
| Deployed hash recomputed from the chain and tied to a build | Yes: `51f64e1a…be62` = the approved v3 build (above) |
| Vault and multisig keys in encrypted offline storage | **No** (F5 / Q-1) |
| Upgrade authority documented as it is | Yes (above) |
| Adversarial tests pass on the release build | Yes: mainnet-fork suites on the v3 binary 1642/1642, memo 16/16, extra 20/20 (2026-10-16/17) |
| Release candidate deployed and re-verified by hash | Yes: deployed 2026-10-18, re-verified the same day |

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
| R-A | A payee that turns on Token-2022 "require incoming memos" makes the signed spend fail; the client has already recorded the digest, so the balance waits until the payee turns it off (PR #13) | Medium for wallets that pay third parties | FIXED on mainnet 2026-10-11 (Squads proposal #7: memo CPI before each transfer, optional 10th account); kept in the v3 build (fork memo suite 16/16). Clients still refuse memo-required recipients before signing |
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
| Q-5 | Dependency advisories in off-chain tooling | Low | PARTLY FIXED 2026-10-18: `web/` 0 advisories (astro upgraded); `app/` shell-quote critical fixed. Still open: bigint-buffer (`app/`, `client/`, via @solana/spl-token, no patched release) and braces (`app/`, transitive via metro). None ship in the on-chain program |
| Q-6 | Pool fees claimable by a hot wallet | Low | FIXED: 2.62 SOL moved to the Squads vault |
| MT-1 | Mutation testing left 9 of 29 mutants alive (PR #14) | Test quality | FIXED 2026-10-18: new tests in `tests/vault.rs` (independent digest reference, program/vault/mint binding, 1-token amount and rest, discriminator, short mint and token-account data) kill all 9 (M02, M09, M13, M14, M17, M18, M20, M22 mint and token account). Run log: `audit/mutants-mt1-2026-10-18.txt`; lib.rs unchanged, clean rebuild hash `51f64e1a…be62` |

## Evidence

| Evidence | File |
|---|---|
| 13 live attacks on the mainnet treasury vault, each rejected with the expected code | `audit/mainnet-attack-run.json` |
| Program suite on a mainnet fork, v3 binary (1642/1642) | `audit/surfpool-fork-v3-2026-10-17.json` |
| Earlier mainnet-fork evidence | `audit/INTERNAL-TEST-EVIDENCE-2026-10-04.md` |
| Program unit, adversarial and fuzz tests | `programs/qc-vault/tests/` |

Reports in open pull requests (property tests, static analysis, mutation
testing, Token-2022 hostile extensions, digest binding) were posted by the
maintainer and have no GitHub reviewer. Their results are counted here only
where a test in `main` reproduces them.
