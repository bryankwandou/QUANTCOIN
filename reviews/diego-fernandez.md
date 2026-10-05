# Tests for the mutants that survived PR #14 — Diego Fernández

PR #14 (mutation testing) left 9 mutants alive. This PR adds
`programs/qc-vault/tests/mutant_killers.rs` with 6 tests aimed at the ones that
are not equivalent and not already covered by the digest-binding tests in PR #16.

Each test was run against the clean program and then against each mutant,
one at a time (`cargo build-sbf` after every patch, sources restored and
checked clean after each run). Full log: `reviews/mutant-killers-output.txt`.

| Mutant | What it changes | Test | Result |
|---|---|---|---|
| M02 | drops the system-program ID check | `m02_fake_system_program_exact_error` | killed |
| M17 | spend of exactly 1 token | `m17_spend_exactly_one_token` | killed |
| M18 | spend leaving exactly 1 token for the refund | `m18_spend_leaving_exactly_one_token_refunds_it` | killed |
| M20 | drops the instruction discriminator check | `m20_wrong_discriminator_is_bad_instruction` | killed |
| M22 | drops the mint data length check | `m22_short_mint_data_is_not_a_token_account` | killed |
| M23 | `remaining() != 9` → `< 9` | `m23_more_than_nine_accounts_rejected` | **survives (equivalent)** |

## M23 is equivalent in practice

With the mutant, a spend that carries 10 or 11 accounts still fails with
`BadInstruction` (1) and the vault balance is unchanged. The lazy entrypoint
reads instruction data from wherever the account cursor stops, so with extra
accounts it reads account bytes as instruction data and the parse fails. The
`!= 9` check is defence in depth, not the only barrier. The test stays in the
suite so that any future change which lets extra accounts reach a valid parse
gets caught.

## Remaining survivors from PR #14

- M05 (bump loop boundary): equivalent, bump 255 is unreachable.
- M09, M13, M14 (mint, program ID, vault dropped from the digest): covered by
  the field-binding tests in PR #16.

## Results

- Clean program: `mutant_killers` 6/6, full `qc-vault` suite passes, `git diff -- programs/qc-vault/src` empty.
- Against mutants: 5 of 6 targets killed; M23 equivalent as explained above.
- No program source is changed by this PR.
