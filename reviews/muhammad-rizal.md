# Muhammad Rizal - qc-vault adversarial LiteSVM tests (E:/qc-pr1-B, HEAD 883c0ec)

Start: 2026-10-05T14:06:52+08:00 (first run). End: see last line of extended-output.txt (rerun with --nocapture ended ~15:00+08:00).

## Steps
- `git status --short`: only `?? programs/qc-vault/tests/extended.rs`. `git diff 883c0ec --stat -- programs/qc-vault/src`: empty, so source is unchanged and the canonical-bump fix is present. Nothing restored.
- extended.rs already had 11 tests (1117 lines) and compiled as is. I changed nothing in it.
- Build/run, per README: `cargo test --manifest-path programs/qc-vault/Cargo.toml --release --test extended` (uses existing target/deploy/qc_vault.so). Cold build took 9m18s.
- Saved run: `cargo test --manifest-path programs/qc-vault/Cargo.toml --release --test extended -- --nocapture --test-threads=1`
- Raw output: quantcoin-vault-review/extended-output.txt

## Result
First run: 11 passed, 0 failed (85.5s). Verbose rerun: 11 passed, 0 failed (161.2s).
Individual cases are far more than 20: fuzz alone is 2200 cases (2000 rejected mutations + 200 valid), and the other tests add hundreds more (all 72 duplicate-slot pairs, about 27 wrong-owner/program cases, 16 canonical bump sweeps, and so on).

## Tests (by area)
- bump: bump_every_valid_noncanonical_rejected_canonical_accepted; bump_edge_cases_0_and_255; cu_canonical_check_accept_and_reject
- tamper: fuzz_byte_flips_fail_valid_spends_succeed (discriminator, bump, seed, amount, sig bit flips, truncate/extend, chain swaps)
- substitution: accounts_swaps_and_random_permutations_rejected; accounts_duplicates_and_wrong_count_rejected (Custom 6 and Custom 1); wrong_owners_and_programs_rejected (wrong owner, mint, token program, ATA, cross-deployment); prefunded_ata_address_is_not_a_token_account
- amounts: amounts_edge_values (0, 1, full, full+1, u64::MAX, 2^63, u64::MAX balances)
- spent marker: replay_after_spend_rejected (Custom 8, including a topped-up marker and a double spend in one tx)
- WOTS reuse: wots_key_reuse_across_vaults_and_owners

## Findings
- No program bug. Every rejection returned the exact expected error code and rolled back fully.
- Design limitation, not a bug: the reuse test forged a valid WOTS signature for the last sibling vault after 3 same-key spends by other owners (found after 51 tries, 497,540 CU). The attacker still needs that vault's owner Ed25519 signature, so a WOTS key must never be reused across vaults or owners. Signature transplant between two same-key vaults is rejected (Custom 2).
- Cosmetic: unused `mut` warning at src/lib.rs:297 (source left untouched).
- Test bugs: none found.
