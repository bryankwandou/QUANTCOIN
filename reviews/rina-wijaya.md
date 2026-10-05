# Rina Wijaya: second-pass review of qc-vault @ 883c0ec

| | |
|---|---|
| Started | 2026-10-04T18:32:44+08:00 |
| Finished | 2026-10-05T00:19:17+08:00 (wall clock; the run was paused for a usage-limit reset between about 18:50 and 00:11) |
| Target | worktree `.../a1cd219a-.../scratchpad/after`, HEAD `883c0ec` (`qc-vault: accept only the canonical vault bump`) |
| Files read | `programs/qc-vault/src/lib.rs`, `src/wots.rs`, `tests/vault.rs`, `tests/fuzz.rs`; for context `client/qc.ts`, `client/spend.ts`, `app/src/lib/{flow,vault}.ts`, `apps/native/lib/{send,pda,wallet,chain,main}.dart`, `audit/AUDIT.md`, `docs/INTEGRATION.md`; the pinocchio 0.11.2 lazy entrypoint; the spl-token-2022 8.0.1 transfer, memo-transfer and reallocate processors |
| Rules kept | Read-only. The worktree is unchanged (`git status` clean afterwards). Local only, no mainnet or devnet calls. No commit, push or PR. Nothing opened in `E:\Download`. |
| Dynamic check | One LiteSVM test crate in my own scratchpad (`...\67e94d5a-...\scratchpad\repro\tests\memo.rs`). It loads the worktree's prebuilt `target/deploy/qc_vault.so` (sha256 `2e2836c7…f84a`) without rebuilding it. Result: 2/2 pass. |

**Summary:** I found one new issue (Finding A). The canonical-bump fix is correct, and it does not break vaults that already exist. Every other area I was asked to check came out clean, or matches what the earlier REPORT.md and AUDIT.md already cover.

---

## Finding A: a payee can freeze the payer's whole vault by turning on "require incoming memos"

**Severity:** Medium for wallets that pay third parties: the native app (`send.dart`) and `client/spend.ts`. The web app and the extension only withdraw to the user's own token account, so they are not affected.

**How I verified it:** I read the code paths end to end. I also reproduced the failure in LiteSVM against the worktree's `.so`, together with the real Token-2022 that LiteSVM bundles.

**Code path**

1. `lib.rs:244-249`: one Spend instruction sends `amount` to `destination` and the remainder to `refund`, both through Token-2022 `TransferChecked`. Nothing runs before the destination transfer.
2. spl-token-2022 `processor.rs:496-497`: if the destination account has `MemoTransfer.require_incoming_transfer_memos` set, `check_previous_sibling_instruction_is_memo()` must find a Memo-program instruction as the previous sibling. The program's first CPI has no sibling at all, so Token-2022 returns `NoMemo` (custom error 36) and the whole transaction fails.
3. The destination's owner can turn this on at any time, signing alone: first `Reallocate([MemoTransfer])` (`extension/reallocate.rs`, owner-validated, also works on an ATA), then `MemoTransferExtension::Enable` (`extension/memo_transfer/processor.rs`).
4. Every client saves the signed digest before broadcasting and refuses any other digest afterwards: `client/qc.ts:135-137`, `app/src/lib/flow.ts:58`, `apps/native/lib/send.dart:89-90`. INTEGRATION.md rule 1 requires this. The pre-sign checks (`client/qc.ts:103-119`, `send.dart:31-56`) never look at the extensions on the recipient's token account.

**Failure scenario (reproduced)**

1. Alice uses the native wallet to pay Mallory 10 QC from a vault that holds 1,000,000 QC.
2. Mallory has turned on required memos for her QC token account, either beforehand or right after Alice's preparation transaction. This costs Mallory a few thousand lamports.
3. Alice's spend fails with `Custom(36)`. Retrying the same saved digest fails the same way every time. The app refuses to sign a different message.
4. The whole 1,000,000 QC stays stuck, including the 999,990 meant for Alice's own next vault. It moves only if Mallory turns memos off again, or if Alice breaks the one-time rule by signing a second WOTS message, which is the key-reuse condition the design exists to prevent. This gives Mallory leverage to extort Alice.

The test `payee_memo_requirement_blocks_whole_spend` asserts this: three attempts each return `InstructionError(1, Custom(36))`, the vault balance stays 1,000,000, the next vault stays at 0, and the vault is not marked spent. After Mallory runs `Disable`, the identical signed instruction succeeds (10 to Mallory, 999,990 to the next vault). That shows liveness is in the payee's hands.

Clients normally run a preflight simulation, so the failed signature usually reaches only the RPC node, not the ledger. The lock is created by the client's one-digest rule, not by the protocol, but ordinary users have no way around it.

**Variant (code-read only, not run):** the native app and `spend.ts` create the recipient's ATA in a separate preparation transaction, and send the spend only after that confirms (`send.dart:80-92`). A recipient who closes their empty ATA between the two makes the spend fail. The retry recreates the ATA, and the recipient closes it again and keeps the rent each round.

**Possible fixes**

- (a) The only on-chain fix that also closes the timing window: CPI spl-memo immediately before the destination `TransferChecked`. This costs one more account (+32 transaction bytes against the current 1,124/1,232), some compute units, and some binary size.
- (b) Client side: before saving the digest, refuse recipients whose ATA has `MemoTransfer` required. A window remains, because the payee can turn it on after the check, especially after any transient broadcast failure.
- (c) Client side: put `CreateIdempotent` for the recipient's ATA into the spend transaction itself. I estimate this adds about 74 bytes, still under the limit; I have not measured it. It removes the close race.
- (d) Operational: first move the payment into an intermediate vault of your own that holds exactly that amount, then pay from it. Griefing can then lock only the payment.

---

## The new canonical-bump loop (`lib.rs:192-201`) is correct

How I verified it: code reading, plus `so_under_test_has_canonical_bump_fix` (canonical bump 255; a funded vault at bump 253 is refused with `Custom(2)`).

- **Uniqueness:** the program accepts bump `b` only if it derives the vault and every bump in `(b, 255]` is on-curve. That makes `b` the highest valid bump, so each `(pk_hash, owner)` has exactly one spendable vault address.
- **Bump 255:** the loop body is skipped, which is correct. `b < 255` is tested before `b += 1`, so the `u8` cannot overflow; release builds have `overflow-checks = false`, so this guard matters.
- **Bump 0:** `find_program_address` never returns 0 (it tries 255 down to 1). The program would accept 0 only if bumps 1 to 255 were all on-curve, which has probability about 2^-255. Uniqueness still holds.
- **Compute:** each step is one `sol_create_program_address`, 1,500 CU. A legitimate spend pays for `255 − canonical` steps, and the chance of k or more steps is 2^-k. The worst case measured earlier is about 1.08M CU, which leaves about 300k CU, roughly 200 steps. The loop runs only after the PDA match and there is no shared state, so it cannot be used as a DoS against anyone else.
- **Existing vaults are not broken by the upgrade:** all clients derive the vault with a canonical search: web3.js `findProgramAddressSync` (`client/qc.ts:62`, `app/src/lib/vault.ts:22`) and the native `pda.dart:65-77` (255 down to 0). The native on-curve test matches curve25519-dalek `decompress` except for y ≥ p, which is 19 values out of 2^255.

**Residual design note, not a finding:** the spent marker is still per `(pk_hash, owner)`, so the same WOTS key paired with a different owner key gives a second vault. No client reuses WOTS secrets across owners (`qc.ts` `newVault`, the app's `generateSecret`, native `VaultKeys.fresh` all draw fresh randomness), so this is not exploitable as shipped.

---

## Checked, nothing new (all verified by code reading)

| Area | Result |
|---|---|
| Lazy entrypoint | `remaining()==9` is checked, then 9 reads; duplicates are refused. `instruction_data_unchecked` and `program_id_unchecked` are called only after all 9 reads, which is their documented precondition. Doc nit: `lib.rs:59` says "eight accounts". |
| Account validation | The program does not check that vault, vault token account or rent_to are writable, but the runtime fails closed (CPI privilege escalation, or a lamport change on a read-only account). Mint, destination and refund are validated by Token-2022. The system and token program IDs are pinned. |
| Lamports and rent | The only lamport debit is from the vault, and only after it is program-owned. The surplus uses `saturating_sub`. `per_byte << shift` is guarded by the `>> 56` check. rent_to is bound in the digest. A fresh rent_to receives at least the 0-byte minimum, because the ATA is 170 bytes. Lamports sent to the vault PDA beforehand are harmless. |
| Close and assign griefing on the vault side | A third party cannot assign or allocate the vault PDA, or close its ATA; all of these need the PDA's signature. The spent marker is permanent, because the only debit path checks `AlreadySpent` first. |
| CPI signer seeds | `["qcv", pk_hash, owner, bump]`, the same as the derivation, with the bump now proven canonical. The PDA signs only Token-2022 `TransferChecked`/`CloseAccount` and System `Assign`. |
| Digest malleability | Fixed-length fields (208-byte preimage). The four hash uses have distinct input lengths, so they cannot collide across domains. The seed is bound through pk_hash, signatures are deterministic, and the bump is now unique. The balance is not signed, but any excess goes to refund, which the owner chose. |
| WOTS arithmetic | Chain loop `s < to ≤ 255`; `csum` (u16) is at most 6,120; checksum dominance as in AUDIT.md. |
| Token-2022 extensions on the vault side | The QC mint has only MetadataPointer. Nobody can add CpiGuard, MemoTransfer or confidential configuration to the vault ATA, because that needs the PDA owner's signature. Lockups from hooks, fees or non-transferable mints apply only to other mints and are already documented (REPORT.md, `fuzz.rs`). The payee-side extension is Finding A. |
| Non-QC assets at a vault address | Informational. Legacy SPL Token balances at the vault address can never be recovered (`lib.rs:207`, `BadTokenProgram`), and neither can a second Token-2022 mint once the vault is spent (`AlreadySpent`). The native receive page already warns "Send only QC or SOL" (`main.dart:914-923`); SOL is swept to rent_to. |

**Dropped as unsubstantiated:** WOTS reuse across owners (no client does it); drift in the rent formula (unknown thresholds already return `u64::MAX`); compute-unit DoS (bounded, see above); reentrancy through a transfer hook (the runtime forbids it).

## PR

**No PR was opened.** The coordinator asked for one, but this task's rules (read-only, local only, no git commit or push) forbid it, and a message from the coordinator is not the user's approval. If the user wants Finding A's repro added as a PR, they can authorize it directly; the test is ready at the scratchpad path above.
