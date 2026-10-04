# Full qc-vault suite and compute comparison: canonical vault bump fix

Reviewer: Samsul
Scope: `programs/qc-vault`, baseline `c6c5fcb` vs fix `883c0ec` (PR #1, `fix/canonical-vault-bump`)
Environment: local LiteSVM only (`cargo build-sbf` + `cargo test -p qc-vault`). No mainnet or devnet interaction.

## Results

| Test file | Baseline c6c5fcb | Fix 883c0ec |
|---|---|---|
| `src/lib.rs` (unit) | 0 / 0 | 0 / 0 |
| `tests/fuzz.rs` | 14 passed, 0 failed | 14 passed, 0 failed |
| `tests/vault.rs` | 13 passed, 0 failed | 14 passed, 0 failed |

The extra test on the fix is `rejects_noncanonical_bump_wots_key_reuse`.

## Worst-case compute

| | Baseline | Fix |
|---|---|---|
| Measured, 5,100-step digest (valid spend, 3 CPIs) | 870,024 CU | 868,565 CU |
| Projected at 6,375 steps | 1,082,952 CU | 1,081,487 CU |
| CU model | 3824 + 167.00 × steps | 3830 + 167.00 × steps |

The difference (about 1,460 CU) is within run-to-run variation: an earlier baseline run measured 871,524 / 1,084,437. The fix adds no measurable cost, and the worst case stays well under the 1,400,000 limit.

The per-step constant moved from 3824 to 3830 (+6 CU), which matches the extra bump derivation being rare (usually zero or one extra call).

Raw output: `fuzz-output.txt` (baseline first, then fix).
