# Dewi Lestari: qc-vault static analysis at 883c0ec

- **Start:** 2026-10-04T18:32:41+08:00
- **End:** 2026-10-05T00:32:31+08:00. Most of the elapsed time went to builds, to `cargo install cargo-deny` (15.5 min) and to a usage-limit pause.
- **Scope:** git worktree `E:/qc-pr1-A`, crate `programs/qc-vault` (`src/lib.rs` 381 lines, `src/wots.rs` 167 lines at the commit). I modified no source.
- **Raw outputs:** `quantcoin-vault-review\static-analysis.txt` (6,098 lines). Per-command files are in `E:/qc-pr1-A/target/dewi-raw/`, which is gitignored.
- **Line numbers** below are from commit 883c0ec unless marked "worktree".

## 0. Read this first: the worktree is not at 883c0ec

`git status` in `E:/qc-pr1-A` shows `M  programs/qc-vault/src/lib.rs`, a **staged** change. It deletes lib.rs:192-201, which is the canonical-bump check this commit adds (`git diff --cached`, section 0 of the txt). HEAD is 883c0ec, but the index and working tree hold the pre-fix, vulnerable logic. Under that logic one WOTS key can sign two spends through a non-canonical bump. Anyone who runs `cargo build-sbf` in this worktree as-is ships the bug, and the regression test `rejects_noncanonical_bump_wots_key_reuse` (tests/vault.rs:401) should fail there.

I did not touch it, because it may be another agent's deliberate experiment. To analyse the real commit I exported it with `git archive 883c0ec ... | tar -x -C target/dewi-snap-883c0ec`. That copy matches the commit except for CRLF line endings. I linted it with a separate `CARGO_TARGET_DIR`. A first attempt shared `target/` and replayed stale cached diagnostics, so I threw it away. Clippy gives the **same warning set** on both trees: static lints cannot detect that the check is missing.

**Decision needed:** the owner of `qc-pr1-A` should confirm the staged revert is intentional and unstage it (`git restore --staged --worktree programs/qc-vault/src/lib.rs`) before any build or PR from this worktree.

## 1. Commands run

| # | Command (cwd) | Result |
|---|---|---|
| 1 | `cargo clippy -p qc-vault --all-targets -- -W clippy::pedantic` (worktree) | exit 0; lib 39, fuzz 46, vault 11 warnings |
| 2 | Same, with `CARGO_TARGET_DIR=target/dewi-snap-target` (commit snapshot) | exit 0; same warning set, shifted +10 lines after lib.rs:191 |
| 3 | `cargo check -p qc-vault --lib` (snapshot, host, no dev-deps) | **exit 101, E0599** (finding R2) |
| 4 | `cargo +1.89.0-sbpf-solana-v1.54 check -p qc-vault --lib --target sbpf-solana-solana` (snapshot) | exit 0, no warnings |
| 5 | `cargo audit` (cargo-audit 0.22.2 was already installed) | exit 0; 0 vulnerabilities, 5 "unmaintained" warnings |
| 6 | `cargo install --locked cargo-deny` | v0.20.2 installed in 15m36s |
| 7 | `cargo deny check` (default config; the repo has no deny.toml) | exit 5; advisories and licences FAILED, bans and sources ok |
| 8 | `cargo deny --config target/dewi-raw/deny-review.toml check` (+ `--exclude-dev`) | full graph: only the 5 unmaintained advisories fail. Production graph: **all ok** |
| 9 | `cargo tree -p qc-vault` (full, `-e normal --target all`, `-d`, `-i <crate>`) | see section 3 |
| 10 | `git grep` on 883c0ec for unsafe, panics, indexing, arithmetic and casts | see sections 4 and 5 |

Clippy covered only the host `cfg`. Platform-tools ships no `clippy-driver`, so the `cfg(target_os = "solana")` branches (lib.rs:298-303, 323-337; wots.rs:61-68) got only an SBF `cargo check` (#4) plus the manual review below.

## 2. Clippy pedantic: real issues vs style

**Clippy found no real defects in `src/`.** All 39 lib warnings fall into these groups (commit lines):

- **Style or API hygiene, no behaviour impact:**
  - `ptr_as_ptr` / `ptr_cast_constness` (lib.rs:79, 169-171, 228; wots.rs:132). Could use `.cast::<T>()`.
  - `borrow_as_ptr` (lib.rs:79). Could use `&raw mut`.
  - `must_use_candidate` (lib.rs:117; wots.rs:59, 85, 91, 102, 119, 145, 149, 158). Worth adding to `spend_digest` and `recover_pk_hash` as cheap hardening.
  - `explicit_iter_loop` (lib.rs:70), `needless_range_loop` (wots.rs:161), `cast_lossless` (wots.rs:108), `wildcard_imports` (wots.rs:142), `semicolon_if_nothing_returned` (lib.rs:259, 375).
- **Docs:** `doc_markdown` (lib.rs:1), `doc_overindented_list_items` (lib.rs:24, 28), `missing_errors_doc` (lib.rs:142).
- **Intentional:** `inline_always` (lib.rs:293, 321; wots.rs:40, 50, 58, 84, 90). It is used on purpose to cut CU cost and binary size.
- **False positives:**
  - `cast_possible_truncation` usize→u8 (wots.rs:130, 152, 162): `i < CHAINS = 26`, so the cast is lossless.
  - rustc `unused_mut` at lib.rs:297 (`let mut r`): `r` is mutated only under `cfg(target_os = "solana")`. The SBF check (#4) does not raise it.

**Tests** (off-chain, 57 warnings): truncating casts in the xorshift PRNG (fuzz.rs:35, 183, 190, 298, 331) are intended. The u64→usize casts are harmless on a 64-bit host. `float_cmp` at vault.rs:248 compares exact literals 1.0 and 2.0 on purpose. The f64 CU projection at vault.rs:202-203 is test-only.

Clippy did not flag the following three issues; I found them in manual review:

- **R1 (high, process):** the staged revert of the canonical-bump fix (section 0).
- **R2 (medium, build):** the host library build is broken without dev-dependencies. `pda()` calls `Address::create_program_address` / `try_find_program_address` (lib.rs:341, 343). Off-chain, solana-address gates both behind the `curve25519` feature, and only the dev-dependency `solana-address = { features = ["curve25519"] }` turns that feature on. As a result, `cargo check -p qc-vault --lib` fails with E0599. `--all-targets` and `cargo test` hide this through feature unification. No other crate in the repo depends on qc-vault today. However, any off-chain Rust client that reuses `spend_digest` / `wots::keys` (as the doc at lib.rs:116 intends) will not compile. Fix: add a `[target.'cfg(not(target_os = "solana"))'.dependencies] solana-address = { version = "~2.6.1", features = ["curve25519"] }`.
- **R3 (low, docs):** lib.rs:59 says the entrypoint "reads exactly eight accounts", but the code requires and reads 9 (lib.rs:65, 68).

## 3. Dependencies: cargo audit, cargo deny, cargo tree

- **Production graph** (`cargo tree -e normal --target all`): `pinocchio =0.11.2` plus five small crates: solana-account-view 2.0.0, solana-address 2.6.1, solana-define-syscall 5.2.0, solana-instruction-view 2.1.0 and solana-program-error 3.0.1. Off-chain only, `sha2 0.10.9` and its RustCrypto deps (cfg not solana). There are no duplicates and no build scripts. That is a minimal, well-pinned on-chain surface.
- **cargo audit:** 338 crates scanned, **0 vulnerabilities**. There are 5 unmaintained advisories: ansi_term RUSTSEC-2021-0139, bincode RUSTSEC-2025-0141, derivative RUSTSEC-2024-0388, libsecp256k1 RUSTSEC-2025-0161 and paste RUSTSEC-2024-0436. `cargo tree -e normal,build -i <crate>` prints nothing for all 5, so **they reach qc-vault only through dev-dependencies** (litesvm / agave test runtime). They are not in the deployed program.
- **cargo deny:**
  - With the default config, every licence is "rejected". That happens because the default allow-list is empty, so it is a missing deny.toml, not a licence problem.
  - With a permissive review allow-list (MIT, Apache-2.0, BSD, ISC, Zlib, Unicode-3.0, etc.), licences and sources pass, and bans pass with 2 duplicate warnings (`solana-define-syscall`, `syn`, both dev-side). The only failures are the same 5 unmaintained advisories.
  - With `--exclude-dev`: advisories, bans, licences and sources all pass.
- **Recommendation:** commit a `deny.toml` (I did not add one, per the no-modification rule) so that CI can run `cargo deny check` meaningfully.

## 4. Unsafe blocks: invariant and whether it holds

There are 16 `unsafe` sites in `src/` at 883c0ec. Every stated invariant **holds**.

| Site | What it does | Invariant relied on | Holds? |
|---|---|---|---|
| lib.rs:63 `unsafe extern "C" fn entrypoint` → `InstructionContext::new_unchecked(input)` | Wraps the loader input buffer | `input` is the SVM-serialized buffer | Yes: only the runtime calls the exported symbol |
| lib.rs:71 `next_account_unchecked()` ×9 | Reads accounts without decrementing `remaining` | Caller guarantees that many accounts exist | Yes: `remaining() != 9` returns early (lib.rs:65), and the loop runs exactly 9 times over a `[_; 9]` |
| lib.rs:76 duplicate rejection (precondition for later unchecked borrows) | `Duplicated(_)` → error 6 | All 9 `AccountView`s are distinct accounts | Yes. This underpins lib.rs:225 and the `&mut` destructuring at lib.rs:150 |
| lib.rs:79 `&mut *(... as *mut [AccountView; 9])` | MaybeUninit array → initialized array | All 9 slots written; `MaybeUninit<T>` has the same layout as `T` | Yes: every iteration writes or returns before line 79 |
| lib.rs:81, 83 `program_id_unchecked()`, `instruction_data_unchecked()` | Reads tail of buffer | All accounts consumed first (they read from the advanced `buffer`; `remaining` is stale but unused) | Yes: called after the 9-account loop |
| lib.rs:138 `copy_nonoverlapping(h, d, 24)` | Truncates SHA-256 output to the digest | 24 ≤ 32 (src) and 24 ≤ 24 (dst); distinct locals | Yes (compile-time constants; could be a `const` assert) |
| lib.rs:165-173 raw reads of `data` at offsets 1, 2, 18, 26 | Parses bump, seed, amount and signature | `data.len() == 650`; reads end at 2, 18, 26 and 650; `[u8; N]` has align 1; instruction data is immutable for the call | Yes: guarded at lib.rs:147 |
| lib.rs:225-229 `borrow_unchecked()` on vault_ta and mint; reads `[64..72]` and `[44]` | Balance and decimals | `data_len ≥ 72` / `≥ 45`; no live mutable borrow; nothing borrowed across the later CPIs | Yes: checked at lib.rs:221; accounts distinct; values copied out and slices dropped at the block end |
| lib.rs:258-264 `invoke_signed_unchecked` CloseAccount | CPI to Token-2022 | Callee-written account data is not borrowed by the caller (solana-instruction-view cpi.rs:627-632) | Yes: no data borrow is live; `vault` passed twice as shared reborrows, which the runtime merges |
| lib.rs:270 `copy_nonoverlapping(program_id, assign+4, 32)` | Builds System `Assign` data | 4 + 32 = 36 = `assign.len()` | Yes |
| lib.rs:274 `invoke_signed_unchecked` System Assign | Marks the vault spent | Same CPI aliasing rule | Yes |
| lib.rs:301-303 `sol_get_rent_sysvar(r)` (SBF only) | Reads Rent | Buffer ≥ 17 bytes and 8-aligned | Yes: `[u64; 3]` = 24 bytes. The return code is ignored, but a failed read leaves zeros → `u64::MAX` → keep all lamports (safe fallback) |
| lib.rs:329-335 `sol_try_find_program_address` / `sol_create_program_address` (SBF only) | PDA derivation | `&[&[u8]]` laid out as (ptr, len) pairs; ≤ 16 seeds of ≤ 32 bytes; `out` is 32 bytes | Yes in practice. The fat-pointer layout is a de-facto rustc guarantee the whole Solana SDK relies on, not a language guarantee. The seeds used are 4×(3/32/32/1) and 3×32 bytes |
| lib.rs:336 `out.assume_init()` | Returns the derived address | Only when `rc == 0` (syscall wrote 32 bytes) | Yes |
| lib.rs:374-380 `invoke_signed_unchecked` TransferChecked | CPI | Same CPI aliasing rule | Yes: called after balance and decimals were copied out |
| wots.rs:45 `take(src, at)` | Copies 24 bytes | `at + 24 ≤ src.len()` | Yes at every call site: `take(&[u8; 32], 0)` (wots.rs:86, 146) and `take(sig, i*24)` with `i < 26` (max 624 = SIG_LEN) |
| wots.rs:54 `put(dst, at, v)` (off-chain only) | Writes 24 bytes | Same as `take` | Yes: `i < 26` into `[u8; 624]` (wots.rs:153, 163) |
| wots.rs:62-67 `sol_sha256(parts, len, out)` (SBF only) | Hash | `&[&[u8]]` as (ptr, len) pairs; `out` is 32 bytes; ≤ 8 slices | Yes (same layout caveat as the PDA syscalls) |
| wots.rs:132 `copy_nonoverlapping(end, ends+i*24, 24)` | Fills MaybeUninit | Offset + 24 ≤ 624; raw-pointer writes, no reference to uninit memory | Yes: `i < 26` |
| wots.rs:136 `ends.assume_init_ref()` | Uses the 624-byte buffer | All 624 bytes initialized | Yes: 26 disjoint 24-byte writes cover [0, 624) |

**Soundness hygiene (style, not a bug):** `take` and `put` are *safe* `fn`s with an unchecked precondition. Release builds drop the `debug_assert!`. They are private, and every caller passes compile-time-bounded offsets, so nothing is reachable today. Making them `unsafe fn`, or array-typed via const generics, would let the compiler enforce the rule.

## 5. Panics and integer overflow on-chain

**Release profile has `overflow-checks = false`** (Cargo.toml:9) and `panic = "abort"`, so any unchecked arithmetic wraps silently on-chain. I checked every operator:

- **No `unwrap`, `expect`, `panic!`, `unreachable!` or `assert!` in `src/`.** The only asserts are two `debug_assert!`s (wots.rs:42, 52), which are compiled out of release builds.
- **Indexing:**
  - `data[0]` (lib.rs:147) is guarded by the short-circuited `len != 650 ||`.
  - Constant indices into fixed arrays: `bump[0]` (lib.rs:195), `assign[0]` (lib.rs:268), `r[0]` and `r[1]` (lib.rs:304), and `data[0]`, `data[1..9]`, `data[9]` on `[u8; 10]` (lib.rs:363-365).
  - `d[i]` and `digest[i]` with `i < 24` (wots.rs:107-108), `d[24]` and `d[25]` (wots.rs:111-112), and `d[i]` with `i < 26` (wots.rs:130).
  - None can panic.
- **Arithmetic, all safe:**
  - lib.rs:197 `b += 1` only runs while `b < 255`.
  - lib.rs:231 `checked_sub`.
  - lib.rs:277 `saturating_sub`.
  - lib.rs:279 `lamports - surplus`: surplus ≤ lamports by construction.
  - lib.rs:280 `wrapping_add`: intentional; total supply is far below u64::MAX, and the runtime's lamport-balance check would reject a wrap anyway. `checked_add` would cost nothing and make the intent clearer.
  - lib.rs:311-314 `per_byte << {7, 8}` is guarded by `per_byte >> 56 == 0`.
  - wots.rs:96 `s += 1` only runs while `s < to ≤ 255`.
  - wots.rs:108 `csum` ≤ 24×255 = 6120 < u16::MAX; `255 - u8` cannot underflow.
  - wots.rs:111-112 the hi digit is ≤ 23.
  - `i * 24` ≤ 600.
- **Casts:** `i as u8` (i < 26), `len as u64` (64-bit SBF) and enum → u64 are all lossless.
- **Logic check of the fix (lib.rs:192-201):** it is correct. For the canonical bump b₀, every bump in b₀+1..255 is on-curve, so `create_program_address` fails for each and the loop passes. Any lower valid bump finds an off-curve higher bump and is rejected. The loop costs about 1,500 CU × (255 − b₀). The expected value is about 1 iteration, since b₀ = 255 with probability ½, and P(b₀ ≤ 255−k) = 2⁻ᵏ. That is negligible next to the 6,375-step WOTS worst case, but the vault.rs:198 CU projection does not include it.

## 6. Not done, and rule notes

- **No commit and no PR.** Mid-task, a coordinator message asked for "a commit authored by Dewi Lestari, and the PR". My assigned rules say "local only, no git commit/push", and another agent's message cannot override them. I made no git writes of any kind. The user can authorise this explicitly if they want it.
- I made no changes to the source in `E:/qc-pr1-A`. My only writes there are under the gitignored `target/` (build output, `dewi-raw/`, `dewi-snap-883c0ec/`, `dewi-snap-target/`, `dewi-sbf-target/`). Those can be deleted with `rm -rf E:/qc-pr1-A/target/dewi-*`.
- I opened no files in `E:\Download`.
- Outside the worktree, the only things touched were cargo-deny installed into `~/.cargo/bin` (as the task asked), the cargo registry/advisory caches, and the two assigned output files.
