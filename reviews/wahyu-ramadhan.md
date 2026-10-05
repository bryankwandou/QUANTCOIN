# Mutation testing of qc-vault security checks - Wahyu Ramadhan

- Worktree: E:/qc-pr1-E at 883c0ec. The tree was clean at the start (no leftovers). `git diff` is empty at the end.
- Started 2026-10-05T14:06:57+08:00. Mutation run 14:18:20 to 15:00:04. Finished about 15:01.
- Method: apply one mutant, run `cargo build-sbf`, run `cargo test -p qc-vault --no-fail-fast` (opt-level 3, target/opt-tests), then `git checkout -- <file>`. Mutants ran one at a time.
- Full table: quantcoin-vault-review/mutation-output.txt
- The .so in target/deploy was rebuilt from the clean source at the end.

## Score: 20 killed / 29 = 69% (9 survived, 0 timeouts)

## Surviving mutants
| id | mutation | note |
|---|---|---|
| M02 | drop system-program address check | the Assign CPI fails anyway; `rejects_fake_system_program` apparently accepts any failure |
| M05 | bump loop stops at 254 | bump 255 is essentially unreachable, so this is likely equivalent |
| M09 | digest omits mint | no test binds the mint into the signature |
| M13 | digest omits program_id | no cross-program replay test |
| M14 | digest omits vault | no test binds the vault into the signature |
| M17 | amount==1 skips the transfer | no 1-token boundary test |
| M18 | rest==1 skips the refund | no 1-token boundary test |
| M20 | drop discriminator check | no test sends a wrong discriminator byte |
| M23 | accept more than 9 accounts | no test passes extra accounts |

M22 (drop the mint data_len check) is counted as killed, but only through `test binary error rc=1` with no named failing test. Treat it as weak and recheck by hand.

## Suggested missing tests
1. Digest binding: for each field (program_id, vault, mint), sign for one value and submit with another, expecting BadSignature. Include a second mint that has a valid ATA.
2. Boundary amounts: spend amount 1 with balance greater than 1, and balance-1 so that rest equals 1. Check the final balances.
3. Instruction byte: data[0] = 1 or 255 with an otherwise valid payload must return BadInstruction.
4. Send 10 or more accounts and assert the failure code.
5. Tighten `rejects_fake_system_program` to assert the exact error code (BadInstruction), not just failure.
6. Short mint and token-account data (less than 45 and less than 72 bytes) must return NotATokenAccount with the exact code.
7. Bump 255: unit-test the loop with a constructed key, or document it as an equivalent mutant.
