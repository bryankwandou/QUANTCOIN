# QuantCoin: Internal Test Evidence, 2026-10-04

Prepared for legal review. Raw logs for every line below are in `audit/evidence-2026-10-04/` in the public repository github.com/bryankwandou/QUANTCOIN.

**What this is.** A complete re-run of QuantCoin's automated tests, done by the project itself with AI assistance on 2026-10-04 (UTC+8), against the code as published on GitHub, plus checks of the live mainnet state, the live website and every released app.

**What this is not.** It is **not an external audit**. No independent party has reviewed the code. Testing shows that the tested cases behave as expected; it cannot prove that no bug exists. The open items at the end are real and are not hidden.

## 1. Summary

| # | Component | Built | Tested how | Result | Evidence |
|---|---|---|---|---|---|
| 1 | Smart contract (vault program `CiupyGrA…`) | Yes, live on mainnet | 27 unit, integration and fuzz tests on the deployed binary | **27 passed, 0 failed** | `01-cargo-test.log` |
| 2 | Contract source = deployed code | Yes | Build from GitHub, compare with the bytes on mainnet | **Identical** (sha256 `07e6b6dd…94be`) | `05-sha-compare.log`, `10-mainnet-state.log` |
| 3 | Contract on a copy of mainnet (fork) | Yes | Full-scale suite (SCALE=1): spends, attacks, fuzzing, replay, concurrency | **1,642 passed, 0 failed** (191 real spends; compute max 867,381 of 1,400,000) | `41-surfpool-suite.log` |
| 4 | Token, multisig, time lock, vaults, pool on mainnet | Yes | 30 read-only checks against mainnet | **30 passed, 0 failed** | `10-mainnet-state.log` |
| 5 | Website quantcoin-pi.vercel.app | Yes, live | 37 live checks: pages, downloads, live balances, RPC proxy security | **37 passed, 0 failed** | `30-live-smoke.log` |
| 6 | Web app (`/app/`) | Yes, live | Unit tests, type check, build | **10 passed**, type check and build OK | `20-…`, `21-…`, `22-…` |
| 7 | Browser extension | Yes, released | 14 unit tests; 14 end-to-end tests in a real browser incl. a withdrawal on a mainnet fork; reproducible build | **14 + 14 passed**; build reproducible byte for byte | `90-…`, `91-…`, `93-…` |
| 8 | Android app | Yes, released | 27 app tests + 2 real devnet sends + released APK launched on an Android 14 emulator + key-store test inside the app | **27 passed**, **2 real sends passed**, **launches**, **key store passed** | `51-…`, `52-…`, `53-…`, `55-…`, CI |
| 9 | Windows app (.exe) | Yes, released | Released .exe launched on this laptop and on a clean Windows CI machine + key-store test inside the app | **Launches**, **key store passed** | CI |
| 10 | macOS app | Yes, released | Released .app launched on a macOS machine (Apple Silicon) + keychain test inside the app | **Launches**, **keychain passed**. A launch bug was found and fixed today (F-10) | CI |
| 11 | iOS app | Built (unsigned .ipa) | Same commit launched on the iPhone simulator + keychain test inside the app | **Launches**, **keychain passed**. Not tested on a physical iPhone | CI |
| 12 | Connectivity between parts | Yes | App ↔ proxy ↔ mainnet; extension ↔ proxy ↔ mainnet; Flutter app ↔ devnet; extension ↔ fork program | **All passed** | `30-…`, `91-…`, `52-…`, `53-…` |
| 13 | Rust dependencies | — | `cargo audit` (338 crates) | **0 vulnerabilities**, 5 "unmaintained" notices | `61-cargo-audit.log` |
| 14 | JavaScript dependencies | — | `npm audit` on every package | Remaining advisories have **no patched version**; see section 6 | `60-…` |
| 15 | Secrets in the public repository | — | Scan of all files and all 39 commits | **0 secrets found** | `80-secrets-scan.log` |

## 2. Smart contract

All commands ran on a clean checkout of the published commit (not on a developer folder).

| What | Result |
|---|---|
| `cargo build-sbf` | exit 0; `qc_vault.so`, 7,456 bytes |
| `cargo test -p qc-vault --release --no-fail-fast` | `fuzz.rs` **14 passed**, `vault.rs` **13 passed**, 0 failed |
| Bytes on mainnet vs. this build | first 7,456 bytes identical (sha256 `07e6b6dd45e6bb7f26ef4ce85f1e6168f8dd1b4bde2b0f4979a5fad6769194be`); the remaining 8 bytes of the account are zero |
| `cargo clippy` | exit 0; 10 style warnings, none about correctness. Not changed, because changing the contract source would make it differ from the deployed code |
| `cargo audit` | 0 vulnerabilities in 338 crates; 5 crates marked unmaintained (`ansi_term`, `bincode`, `derivative`, `libsecp256k1`, `paste`), all pulled in by test or SDK tooling |

The 27 tests cover, among others: spend needs both the Ed25519 signature and the one-time Winternitz signature; a changed amount, destination, owner, token program or signature is refused; replay after a spend is refused; random data and mutated signatures (fuzzing) are refused; the worst-case compute cost fits a Solana transaction.

## 3. Mainnet state (read-only, 30 checks)

`client/verify-mainnet.ts` reads mainnet and signs nothing. 30 of 30 passed, including: program owned by the upgradeable loader; upgrade authority is the Squads vault `45nAvRrg…`; multisig `A9tdTp68…` is 2-of-3 with a 24-hour time lock and no config authority; supply 22,000,000,000,000 QC, 5 decimals; no mint, freeze or metadata authority; every vault on the transparency page is a QC account with no delegate or close authority; all QC token accounts add up to the supply; the project's pool position is 100% permanently locked; the deployed bytecode equals the local build; the transparency page lists the multisig, Squads vault, pool and position that were checked.

## 4. Apps and connectivity

**Website (37/37).** All 7 pages return 200 with no browser console errors (English and Indonesian). The badge says Mainnet. The install section links the 6 release files and each download returns 200. The transparency page shows live balances and the new governance section. The RPC proxy accepts the site and the extension, and refuses other websites, other extensions, unknown methods, oversize bodies, batches over 20 and GET.

**Web app.** 10 unit tests, type check, production build: all pass after today's dependency upgrades.

**Browser extension.** 14 unit tests pass. 14 end-to-end tests pass in Microsoft Edge with the built extension: it reads mainnet through the proxy, creates an owner key and vault, stores both encrypted (PBKDF2 600,000 rounds + AES-GCM), refuses a wrong password, exports and re-imports a backup, and completes a real withdrawal on a mainnet fork against the deployed program (1,234.5 QC received, 8,765.5 QC moved to the next vault). Two clean builds produce identical files, and the released zip is that build.

**Flutter app (Android, Windows, macOS, iOS share this code).** `flutter analyze`: no issues. `flutter test`: 27 passed, 2 skipped by design (they spend devnet funds). Those 2 were then run for real on devnet:
- `devnet_send_test.dart`: two spends signed in the app's own code landed on devnet (`31dfLLL9…`, `3M2Dgfd5…`).
- `ui_send_e2e_test.dart`: the app's screens were driven by simulated taps (passcode, import vault, recipient, amount, confirm) and the send was verified on chain (`ZnH5YhXR…`).

**Release binaries launched on real operating systems** (GitHub Actions; the file is checked against `SHA256SUMS.txt` before launch):

| Build | Where it was launched | Result |
|---|---|---|
| Android APK | Android 14 emulator | Launches, passcode screen, process alive after 25 s, no errors in logcat |
| Windows .exe | This laptop (Windows 11) and a clean Windows Server CI machine | Launches, passcode screen |
| macOS .app | macOS 26 CI machine (Apple Silicon) | Launches (process alive after 25 s), passcode screen. Ad-hoc signature verifies |
| iOS | iPhone simulator (simulator build of the same commit; the unsigned .ipa is a device build and cannot run in a simulator) | Launches (process alive after 25 s), passcode screen |

Runs: smoke on the final release, GitHub Actions run 37177474011 (after the APK was re-signed; all 4 passed) and 37164277322 (all 4 jobs passed; screenshots and checksum checks in `ci-smoke-37164277322/`). The earlier runs 37163022346 and 37163296309 failed on macOS only; that failure is F-10.

**Key-store test inside the real app** (`integration_test/keystore_device_test.dart`: write vault keys to the platform keychain/keystore, read them back, compare, delete): **passed on Android emulator, iPhone simulator, macOS and Windows** (GitHub Actions run 37163435149).

## 5. Problems found today and what was done

Testing found real problems. Each is listed with its fix and the proof.

| ID | Problem | Fix | Proof |
|---|---|---|---|
| F-8 | An old public repository (`VincentiusBryanKwandou/QUANTCOIN`) still showed the earlier false claims (1 trillion TPS, quotes attributed to Elon Musk and Sam Altman) | Made private on 2026-10-04; public URL now returns 404. The old account name `nayrbryanGaming` no longer exists (renamed to `bryankwandou` on 2026-09-17), so its old URL also returns 404 | `curl` 404; scan of every public repo of both accounts found no other QuantCoin copy with those claims |
| F-9 | The browser extension's source code was not in the public repository, although its zip was released | Committed (commit `63465ed`); its private signing key stays out of git | repository |
| F-10 | **The released macOS app did not start.** It requested a restricted keychain entitlement that an ad-hoc signed app may not have, so macOS refused to launch it | Entitlement removed; the app uses the standard macOS keychain (commit `5a0dd58`); rebuilt and re-released | Before: run 37163296309, launchd error 162. After: run 37164277322 launches; keychain test passes on macOS (run 37163435149) |
| F-11 | The extension only built because of leftover files on the developer's machine; a fresh install failed | Build tools pinned in `apps/package.json`; line endings fixed so the build is identical on every OS (commit `a588658`) | `93-extension-reproducible-build.log` |
| F-12 | The released extension zip could not be reproduced from the source | Replaced with the reproducible build; old and new checksums recorded | release notes, `93-…` |
| F-13 | Windows, macOS and iOS were reported as "not built" on 2026-10-03 | Built by GitHub Actions and added to the release | release `app-v0.1.0` |
| F-14 | Two Flutter tests failed on 2026-10-03 (missing settings) | Marked as opt-in with a stated reason; run for real today and passed | `52-…`, `53-…` |
| F-15 | Mainnet check script was out of date and would report false failures | Replaced by the maintained 30-check script | `10-mainnet-state.log` |
| F-16 | Transparency page did not show the multisig, time lock, pool or locked position | Added, and the check script now verifies the page | live site, `30-…` |
| F-17 | Critical advisory in the website framework (Astro) | Upgraded Astro 5 → 7 | `60-npm-audit-web.log` |

Mistakes in the test setup itself are also kept, with their logs, so a reader can see them: the first contract test run was started before the build (`01a-…`), the first fork suite run used an unfunded fee payer (`41a-…`), the second stalled at 1,500 tests with 0 failed on a confirmation with no timeout (`41b-…`; now capped at 60 s), and one Flutter run used an already-spent key (`53a-…`, where the app correctly refused it). None of these is a product fault; each was re-run correctly.

## 6. Dependency advisories that remain

After upgrades and overrides, the remaining JavaScript advisories are in packages for which **no fixed version exists** today:

| Package | Where | Why it remains | Exposure |
|---|---|---|---|
| `bigint-buffer` ≤ 1.1.5 (high) | Solana SDK (`@solana/spl-token`), in `app/` and `client/` | 1.1.5 is the newest release; there is no fix | In the browser the package uses its pure-JavaScript code, not the native code the advisory is about. `client/` is the operator's own command-line tooling |
| `braces` ≤ 3.0.3 (high) | build tools in `app/` | 3.0.3 is the newest release | Build time only; not shipped to users |
| `http-cache-semantics` ≤ 4.2.0 (high) | Astro, in `web/` | 4.2.0 is the newest release | Build time only; the built site contains no copy of it (checked) |

## 7. What testing cannot show, and what is still open

1. **No external audit.** This is the project's own testing.
2. **No proof of "zero bugs".** Tests show that the tested cases work. Untested situations can still fail.
3. **Q-1 Key custody (critical, open).** Two of the three multisig keys and their seed phrases are still stored as plain files on the developer's laptop. Whoever controls that laptop controls 2 of 3 keys and could upgrade the contract, after the 24-hour time lock. Fix: move the two keys to two separate offline places, then delete the files. Only the owner can do this.
4. **Q-2 The contract can still be upgraded (high, by design until the external audit).** Until it is made final, its quantum protection depends on the multisig keys, which use Ed25519.
5. **Unsigned apps.** Windows and macOS builds are not code-signed (the OS shows a warning); the iOS build is unsigned and installs only by sideloading; the Android APK is signed with the project release key (commit `c6c5fcb`, certificate SHA-256 `dbec38c5…9d74`, see `57-…`). Store distribution (Play Store, App Store) is not done.
6. **iOS on a real iPhone** was not tested; only the simulator.

## 8. Reproduce

```
git clone https://github.com/bryankwandou/QUANTCOIN && cd QUANTCOIN
cargo build-sbf --manifest-path programs/qc-vault/Cargo.toml && cargo test -p qc-vault --release
cd client && npm ci && npx tsx verify-mainnet.ts            # 30 read-only mainnet checks
cd ../app && npm ci && npx vitest run && npm run build
cd ../apps && npm ci && cd extension && npm test && npm run build
cd ../native && flutter test
```
Release files: github.com/bryankwandou/QUANTCOIN/releases/tag/app-v0.1.0 (checksums in `SHA256SUMS.txt`).
