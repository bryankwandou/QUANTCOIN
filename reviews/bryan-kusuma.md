# Agent report: Bryan Kusuma (WOTS host-side property tests)

- Start: 2026-10-04T18:32:32+08:00
- End:   2026-10-05T00:23:50+08:00 (the active work took about 1 h. The gap between about 19:10 and 00:11 was a usage-limit pause, not test runtime.)
- Scope: `programs/qc-vault/src/wots.rs` in git worktree `E:/qc-pr1-C`, detached at commit `883c0ec`.
- Rules followed: local only, nothing pushed or published, no files opened in `E:\Download`, work kept inside `E:/qc-pr1-C` plus the two output folders below.

## Result

All 6 properties pass at the default 10,000 base cases. No real bug was found in `wots.rs`. No test errors remain.

| Property | What it checks | Cases in the full run |
|---|---|---|
| p01 | `recover_pk_hash(seed, d, sign(master, seed, d)) == public_key_hash(master, seed)` | 10,006 round-trips (6 fixed corner digests + random and adversarial digests) |
| p02 | Checksum non-domination: for distinct digests, some digit strictly decreases | **Exhaustive** over all 18,730,260 checksum pairs, plus 400,000 random/adversarial pairs and 5,865 byte-boundary cases |
| p03 | 26 digits, message digits equal the digest bytes, checksum = sum(255 - d_i) ≤ 6120 (hi ≤ 23, and lo ≤ 232 when hi = 23), verifier steps ≤ 6375, layout constants | Exhaustive over all 6,121 checksum values, plus 100,000 random digests |
| p04 | Domain tags distinct and prefix-free, fixed preimage length per domain (52/647/208/40 bytes), each primitive uses its own tag, the 26×256 (chain, step) tweaks give distinct outputs, seed binding (in the chains and in the final pk hash), master binding, recovery under a wrong seed fails, every `spend_digest` field is bound | 10,000 hash-level cases + 4×6,656 tweak sweep + 1,000 full keys (50 of them recomputed independently from raw SHA-256) |
| p05 | Any single-byte signature change alters the recovered pk_hash; swapping two chains and changing the digest also fail | 11,068 tamper cases, including 8 full 624-byte sweeps and all 255 XOR values at 4 positions |
| p06 | `chain(b..e, chain(a..b, x)) == chain(a..e, x)`; identity; single step; `from > to` is the identity; the non-positional form `chain(0..q, chain(0..p, x)) != chain(0..p+q, x)` (the step index is in the tweak); chain index is bound; the per-chain verification relation; a forward-walk forgery attempt | 10,000 composition cases + 1,000 keys, of which 919 forward-walk forgeries were attempted and refused |

**Note on "chain(chain(x,a),b) == chain(x,a+b)":** the API takes absolute positions `from..to`, and the step index is part of the hash tweak. So the law that holds is the positional one: `chain(b, e, chain(a, b, x)) == chain(a, e, x)`. The literal form, restarting at 0, must not hold, and p06 checks that it does not. If it held, the step tweak would be missing.

**Mutation check (shows the tests are not vacuous).** I mutated `wots.rs` temporarily, then restored it byte for byte; `git diff` was clean afterwards.
- M1: drop the high checksum digit. Caught by p02 and p03.
- M2: drop the step index from the `chain_step` tweak. Caught by p04 and p06.

p01 (round-trip) and p05 (tamper) pass under both mutants, because sign and recover share `digits()` and `chain()`. A round-trip test alone would not catch either bug.

## Method

- **Seeded RNG, not proptest.** proptest is not in the local cargo cache (`~/.cargo/registry`), and the task is local only, so I did not download it. I used a splitmix64 PRNG instead, matching the existing `tests/fuzz.rs` approach. Settings:
  - `QC_PROP_SEED` (default 5890952811885109286) and `QC_PROP_CASES` (default 10000) can be changed; every test prints its seed.
- **Signer.** The existing host-side signer `wots::keys::{sign, public_key_hash, secret_chain}`, the same one `tests/vault.rs` and `tests/fuzz.rs` use.
- **Adversarial digest generator.** Mixes uniform digests with:
  - near-max digits (250..255), near-min digits (0..5) and all-0xff-but-one
  - constant digests and real `spend_digest` outputs
  - digests built to land on an exact checksum, including the byte boundaries 255/256/511/512/5887/5888/6119/6120 and every 256·h.
- **Speed.** The debug build was about 140 ms per round-trip, so the full run raises opt-level for `qc-vault` and `sha2` through `--config` flags; no file was edited. `debug-assertions` and `overflow-checks` stay on, so the `debug_assert!` bounds checks in `take`/`put` were active for the whole run.

## Commands

```
cd E:/qc-pr1-C
git status                       # clean, detached 883c0ec; no partial files from an earlier attempt
cargo test --offline -p qc-vault --test wots_props --no-run          # first build, debug (8m15s)
QC_PROP_CASES=200 cargo test --offline -p qc-vault --test wots_props -- --nocapture   # timing pass, 6/6 ok, 164 s
cargo test --offline -p qc-vault --test wots_props \
  --config 'profile.test.package.qc-vault.opt-level=3' --config 'profile.test.package.sha2.opt-level=3' \
  --config 'profile.dev.package.qc-vault.opt-level=3'  --config 'profile.dev.package.sha2.opt-level=3' \
  -- --nocapture --test-threads=6                                    # FULL run: 6 passed, 0 failed, 21.3 s
# mutation check: QC_PROP_CASES=500, same flags -> 2 passed / 4 failed (expected); restored -> 6/6 ok
```

`tests/vault.rs` and `tests/fuzz.rs` were not run. They need `target/deploy/qc_vault.so` (an SBF build) and were outside this task.

## Files

- New test (untracked in the worktree): `E:\qc-pr1-C\programs\qc-vault\tests\wots_props.rs`
- Copy: `E:\000VSCODE PROJECT MULAI DARI DESEMBER 2025\quantcoin-vault-review\wots_props.rs` (sha256 8e61a6b8…492c, identical)
- Output: `E:\000VSCODE PROJECT MULAI DARI DESEMBER 2025\quantcoin-vault-review\wots-props-output.txt` (full 10k run + mutation summary)
- No other file changed. `src/wots.rs` matches HEAD. `Cargo.toml` and `Cargo.lock` are untouched.

## Real bugs vs test errors

- **Real bugs in wots.rs: none found.**
- **Test errors: none.** My first build had one compile fix (an `&&[u8]` pattern in p04) and one unused-assignment warning. Both were fixed before any run. The run log still shows one pre-existing warning, `unused mut` at `src/lib.rs:297`. It is harmless, and it is in lib.rs, not in my file.

## Crypto notes (none blocking)

1. **Checksum soundness is proven, not just sampled.** p02(a) checks every pair of checksum values. Together with "raising message digits strictly lowers the checksum", this covers every possible domination attempt for w = 256, 24+2 digits.
2. **Master reuse hazard (design note).** `secret_chain(master, i) = H("QCV1/sk" || master || i)` does not depend on `seed`, so the chain start is the same for every seed. A signature with digit 0 on chain i reveals that start directly. Any other vault with the same master, even with a different seed, then has chain i fully exposed. The web client (`app/src/lib/vault.ts`) and the native client (`apps/native/lib/wallet.dart`) both draw a fresh random master and seed per vault, so nothing triggers this today. Hashing the seed into `secret_chain`, or documenting "one master per vault" as a hard rule, would remove the footgun.
3. **Seed is the only per-key tweak.** Multi-target protection across keys depends on the 16-byte client-chosen seed being unique. Clients use CSPRNG seeds, which is fine. A buggy client that reuses seeds weakens this only to about 2^192 / #keys per chain value, so this is low risk.
4. **192-bit truncation.** Second-preimage security is about 2^192 classical and about 2^96 with Grover, as the module doc says. Collisions on the 192-bit digest cost about 2^96 classical and about 2^64 quantum (BHT). That only matters if the owner can be made to sign an attacker-chosen colliding message, and the owner builds the digest from the transaction accounts themselves. Low risk.
5. **`chain(from > to)` silently returns `x`.** The program cannot reach this, since digits ≤ MAX_STEP = 255, but a future caller could misuse it. p06 documents the behaviour.
6. **`take`/`put` use raw pointer copies, guarded only by `debug_assert!`.** Every call site uses fixed-size arrays and constant offsets. The tests ran with debug assertions on and never tripped them.

## Coordinator request not carried out

On 2026-10-05 the coordinator asked for "a commit authored by Bryan Kusuma, and the PR". **I did not commit, push, or open a PR.** The user's rules for this task say "local only, no git commit/push", and a message from another agent cannot override the user's instructions. The test file is left untracked in `E:/qc-pr1-C` and is ready to commit if the user approves it directly.
