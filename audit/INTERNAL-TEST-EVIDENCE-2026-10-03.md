# QuantCoin — Internal Test Evidence, 2026-10-03

**What this is:** an internal, automated test pass run by the project's own tooling (an AI engineering agent operating on the developer's machine). **It is not an external security audit.** Testing can show that specific cases behave as expected; it cannot prove the absence of bugs.

Raw logs and the test scripts written for this pass are in `audit/evidence-2026-10-03/`. Every result below is copied from those logs. Nothing was pushed to git, deployed, or published, and no mainnet funds were moved; all mainnet calls were read-only. The mainnet-fork tests ran against a local Surfpool fork with throwaway keys.

## Summary

| # | Component | Pass | Fail | Not run / skipped |
|---|---|---|---|---|
| 1 | On-chain program (qc-vault): unit + fuzz tests | 27 | 0 | — |
| 1 | Program build reproducibility (local build vs. on-chain bytes) | 1 | 0 | — |
| 1 | Clippy (lint) | ran, exit 0 | 10 warnings (style only) | — |
| 2 | Mainnet state (read-only) | 28 | 0 | — |
| 3 | Web app `app/`: unit tests / typecheck / build | 10 tests + typecheck + build | 0 | — |
| 3 | Website `web/`: build | 14 pages built | 0 | — |
| 3 | Live site smoke + RPC proxy (Playwright, Edge) | 22 + 2 follow-up | 1 (test design error; see F-1) | — |
| 4 | Mainnet-fork end-to-end vault suite (Surfpool) | 394 | 0 | scaled to 0.2× (see L-4) |
| 4 | Mainnet-fork pool checks | 5 | 0 | — |
| 5 | Flutter app `apps/native`: analyze | No issues | 0 | — |
| 5 | Flutter app `apps/native`: tests | 27 | 2 (devnet tests needing env vars and devnet keys; see F-2) | — |
| 6 | Dependency audit (npm) | — | 50 advisories reported (see F-3) | `cargo audit` not installed |
| 7 | Cross-component address consistency | consistent where present | gaps (see F-4) | — |
| 8 | Secrets scan (tracked files + history) | 0 secret keys found | — | history checked for keypair arrays and key paths only (see L-6) |
| — | Browser extension `apps/extension`: unit tests | 14 | 0 | — |
| — | Browser extension: mainnet read (reported by the extension's build agent, not re-run separately here) | 8 | 0 | — |
| — | Browser extension: fork end-to-end, re-run 2026-10-03 23:24 after the proxy fix | 14 | 0 | earlier run: 13/14 (see F-7) |
| — | RPC proxy curl checks (extension origin, site origin, foreign origin) | 3 | 0 | — |
| — | Android release APK | built (not built in this pass) | — | SHA-256 below |
| — | Windows `.exe` | — | — | **NOT BUILT: Visual Studio C++ workload missing** |
| — | iOS / macOS builds | — | — | **NOT BUILT: needs a Mac** |

## 1. On-chain program

| What | Command | Result | Log |
|---|---|---|---|
| Unit, integration and fuzz tests | `cargo test -p qc-vault --release` | **27 passed, 0 failed** (14 + 13 across two test binaries), 959 s | `01-cargo-test.log` |
| Build for Solana | `cargo build-sbf` | exit 0, 57 s. Output `target/deploy/qc_vault.so`, 7,456 bytes (cargo found it up to date, so the file was not rewritten) | `02-build-sbf.log` |
| Dump on-chain program | `solana program dump -um CiupyGrAtWomKW5rDWbaMEsm3Db8pY8NPECgL2FfACms` | 7,464 bytes | `04-dump.log`, `onchain-program.so` |
| Compare bytes | sha256 of first 7,456 on-chain bytes vs. local `.so` | **Match**: `07e6b6dd45e6bb7f26ef4ce85f1e6168f8dd1b4bde2b0f4979a5fad6769194be`; the remaining 8 on-chain bytes are all zero | `05-sha-compare.log` |
| Lint | `cargo clippy -p qc-vault --all-targets --release` (clippy installed first with `rustup component add clippy`, a test-environment fix) | exit 0, **10 warnings**: 2 "doc list item overindented" (`lib.rs:24,28`), 1 "variable does not need to be mutable" (`lib.rs:287`), 1 needless range loop (`wots.rs:161`), 2 needless range loops in `tests/fuzz.rs`, plus summary lines. None reported as errors or correctness lints | `03-clippy.log` |

Note: the older file `target/deploy/qc_vault.mainnet-93abe8ef.so` (the 2026-09-30 build) no longer matches the chain, which is expected: the program was upgraded after it was built (commit `344c2a5`). `client/verify-mainnet.ts` still expects that old hash, still expects time lock 0, and still lists the original vault set. **That script is stale and would report false failures**, so this pass used a new read-only checker instead (`mainnet-readonly-check.ts`).

## 2. Mainnet state (read-only)

Command: `npx tsx mainnet-readonly-check.ts ../transparency/index.html` (run from `client/`, public RPC, 2.5 s delay between calls). **28 passed, 0 failed**, 777 s. Log: `10-mainnet-state.log`.

| Check | Result |
|---|---|
| Program executable, owned by the upgradeable loader | PASS |
| Upgrade authority = Squads vault `45nAvRrgqxkdnsDmW9dmukHNcxE1TM5PnJsH27cTXxez` | PASS |
| Multisig `A9tdTp68…` owned by Squads v4, threshold 2, 3 members | PASS |
| Multisig time lock = 86,400 s (24 h) | PASS |
| Multisig config authority = none | PASS |
| Vault PDA (index 0) derives from the multisig | PASS |
| Supply = 22,000,000,000,000 QC, 5 decimals | PASS |
| Mint authority none; freeze authority none | PASS |
| Extensions are only MetadataPointer + TokenMetadata | PASS |
| Metadata pointer and metadata update authority none; name QuantCoin, symbol QC | PASS |
| Each vault listed on the transparency page: token account is QC, owned by the listed vault, no delegate, no close authority (8 open; `founder1` original account is closed) | PASS (8/8) |
| Listed vaults + all other holders = exactly 22,000,000,000,000 QC | PASS. Listed vaults hold 21,977,999,999,999 QC; three other accounts hold 22,000,000,001 QC (21,862,961,121.273 + 137,038,878.727 + 1) |
| Sum of all 18 QC token accounts = supply | PASS |
| Pool `AyS1vByi…` holds QC/SOL; project position `7Bqgd7Ay…` fully locked (permanent locked liquidity 19,347,108,405,599,856,524,008,257,940,930; unlocked 0; vested 0) | PASS |

Balances on the treasury vault are 7,699,999,999,999 QC (1 QC below its 7.7 T allocation) and liquidity 4,378,000,000,000 QC; the difference is accounted for by the three outside accounts above (the pool vault and others). This pass checked that the totals reconcile. It did not trace who owns the outside accounts.

## 3. Web app, website, live site

| What | Command | Result | Log |
|---|---|---|---|
| App unit tests | `npx vitest run` (in `app/`) | 3 files, **10 passed** | `20-app-vitest.log` |
| App typecheck | `npx tsc -b` | exit 0 | `21-app-typecheck.log` |
| App build | `npx vite build` | exit 0 | `22-app-build.log` |
| Website build | `npm run build` (in `web/`) | 14 pages built, exit 0 | `23-web-build.log` |
| Live smoke, https://quantcoin-pi.vercel.app | `node live-smoke.cjs` (Playwright from `apps/node_modules`, `channel:'msedge'`) | **22 passed, 1 failed** | `30-live-smoke.log` |
| `/app/` reaches mainnet via proxy (follow-up) | `node app-rpc-reach.cjs` | bundle uses `location.origin + /api/rpc/`; an in-page call through the proxy returned HTTP 200 and the real QC mint account | `31-app-rpc-reach.log` |

Live smoke detail: `/`, `/id/`, `/whitepaper/`, `/launch/`, `/audit/`, `/transparency/`, `/app/` all returned HTTP 200 with no console errors. `/transparency/` showed the live balances (22,000,000,000,000; 7,699,999,999,999; 4,378,000,000,000; …) and every `/api/rpc` call returned 200. RPC proxy: allowed origin 200, foreign origin 403, `getProgramAccounts` rejected 400 "method not allowed", 70 KB body rejected 413, batch of 21 rejected 400, GET rejected 405.

## 4. Mainnet-fork end-to-end (Surfpool)

Fork: `surfpool start --network mainnet --no-tui --port 8899` (surfnet 1.2.1, forked at mainnet slot 452,910,660). The fork uses the real deployed program and the real QC mint. Surfpool's attempt to deploy the local workspace failed ("not a terminal"), which is harmless here because the tests target the cloned mainnet program. The process was stopped by its own PID (6659) afterwards.

| What | Command | Result | Log |
|---|---|---|---|
| Vault suite | `SCALE=0.2 SURF_RPC=http://127.0.0.1:8899 SURF_PAYER=<throwaway key> npx tsx surfpool-suite.ts` | **394 passed, 0 failed**, 452 s | `41-surfpool-suite.log`, `42-surfpool-fork-report.json` |
| Pool checks | `npx tsx pool-fork-check.ts` | **5 passed, 0 failed**, 391 s | `43-pool-fork.log` |

Vault suite groups: G0 fork sanity 3; G1 create, fund and spend with the remainder rotated to a fresh vault, 30; G2 overspend refused, 4; G3 fuzz (tampered owner, destination, amount, accounts, signatures), 256 refused as expected; G4 replay and double spend refused, 16; G5 signature transplant refused, 6; G6 concurrency, 3; G7 compute ceiling (2^63 amount fits), 1; G8 mainnet transaction data re-verified, 72; G9 F9 regression, 3. Spend compute: min 439,701, median 573,786, max 868,881 CU (cap 1,400,000). Funding was done with Surfpool's token cheatcode, not with a wallet transfer.

Pool: price at fork start was above the opening floor (`sqrtMinPrice`); a 1 SOL buy raised the price; selling the bought QC lowered it and it stayed at or above the floor; an attempt to dump 5 trillion QC was **rejected** by the pool program (custom error 0x177f), so the price stayed above the floor; after 20 random trades the price never went below the floor. Note that the dump test shows a rejected trade, not a partial fill at the floor.

## 5. Flutter app (`apps/native`)

| What | Command | Result | Log |
|---|---|---|---|
| Static analysis | `flutter analyze` | **No issues found**, 752 s | `50-flutter-analyze.log` |
| Tests | `flutter test -r expanded` | **27 passed, 2 failed** | `51-flutter-test.log` |

The two failures are the network/devnet tests `devnet_send_test.dart` ("treasury vault -> app vault -> fee wallet") and `ui_send_e2e_test.dart` ("send through the UI lands on devnet"). Both stop with "Null check operator used on a null value" because they need the environment variables `QC_FROM` / `QC_RPC` and a devnet payer key; they send real devnet transactions. They were not configured for this pass, so these two cases are **untested**, not passed. The network test `chain_live_test.dart` (reads a real devnet token account) passed.

## 6. Dependency audit

| Project | Command | Result | Log |
|---|---|---|---|
| `app/` | `npm audit --omit=dev` | **31 vulnerabilities (15 moderate, 16 high)**, e.g. `bigint-buffer` (high), `braces` (high), `stream-json`, `uuid` | `60-npm-audit-app.log` |
| `web/` | `npm audit --omit=dev` | **4 vulnerabilities (1 low, 2 high, 1 critical)**: `astro` (critical; XSS in `define:vars`, server-island replay), `sharp`/libvips (high), `http-cache-semantics`, `esbuild` | `60-npm-audit-web.log` |
| `client/` | `npm audit --omit=dev` | **15 vulnerabilities (8 moderate, 7 high)**, e.g. `bigint-buffer`, `toml`, `stream-json`, `uuid` | `60-npm-audit-client.log` |
| Rust | `cargo audit` | **not run**: `cargo-audit` is not installed | `61-cargo-audit.log` |

Not assessed: whether each advisory is reachable in how QuantCoin uses the package. `web/` is a static site built at deploy time, which limits but does not remove exposure for the build-time packages. `client/` is the operator's local tooling.

## 7. Cross-component consistency

Log: `70-consistency.log`. Wherever an address appears it is the same value; no conflicting address was found.

| Address | Program src | `app/src/lib/config.ts` | `apps/native` | `transparency/index.html` | `web/src` | `WHITEPAPER.md` | `brand/metadata.json` |
|---|---|---|---|---|---|---|---|
| Mint `AsEE…` | — (not hard-coded) | yes | yes (`chain.dart`) | yes | yes | yes | — (metadata lives on the mint) |
| Program `Ciupy…` | — (no `declare_id`; ID taken at runtime) | yes | yes (`wallet.dart`, not `chain.dart`) | yes | yes | yes | — |
| Multisig `A9td…` | — | — | — | **absent** | **absent** | **absent** | — |
| Squads vault `45nAv…` | — | — | — | **absent** | **absent** | yes | — |
| Pool `AyS1…` | — | — | — | **absent** | **absent** | yes | — |
| Position `7Bqgd…` | — | — | — | **absent** | **absent** | **absent** | — |

`chain.dart` also holds the devnet mint `BUoNsF…`, labelled devnet; that is correct. The transparency page and website do not mention the 24-hour time lock (the whitepaper does).

## 8. Secrets scan

Log: `80-secrets-scan.log` (paths only; no secret was printed).

- Tracked files with a 64-number JSON array (keypair file format): **none**.
- Tracked files with 87–88 character base58 strings: 13 files. All 90 such strings were decoded and tested; **0 are valid Ed25519 secret keys** (they are transaction signatures).
- Tracked files that mention "private key" / "seed phrase" / "mnemonic": `WHITEPAPER.md`, `design/APP-DESIGN-SPEC.md`, `programs/qc-vault/src/lib.rs`, all prose or comments.
- Git history: no file under `keys/`, `keys-mainnet/`, `*keypair*` or `id.json` was ever added; no commit diff adds a 64-number array. `.gitignore` excludes `/client/keys/` and `/client/keys-*/`.
- Not tracked, but present on disk: `client/keys/`, `client/keys-mainnet/` (vault keys), and `apps/extension/keys/` (created by another agent). They are excluded from git, but their safety depends on this machine's security (see Q-1).

## Browser extension, proxy, Android APK

| What | Command | Result | Log |
|---|---|---|---|
| Extension unit tests | `npm test` (in `apps/extension`) | 4 files, **14 passed** | `90-extension-test.log` |
| Extension fork e2e (Edge, Surfpool mainnet fork, includes the mainnet read through the proxy) | `SURFPOOL=http://127.0.0.1:8899 node e2e/run.mjs` | **14 passed, 0 failed**, 153 s | `91-extension-e2e-fork.log` |
| Proxy, curl | `curl -H "origin: <o>" -d getTokenAccountBalance(CrZm5SGo…) https://quantcoin-pi.vercel.app/api/rpc/` | extension origin `chrome-extension://nbchhoognfblfokeiknmgbjghembmona` 200; site origin 200; `https://evil.example` 403 | `32-proxy-curl.log` |
| Android APK | `sha256sum apps/native/build/app/outputs/flutter-apk/app-release.apk` | `0f5fae63d3b30332e59fb259300a0539ad874ffc6cceaf4c71efbde427df399c` (same for `apk/release/app-release.apk`) | — |

Raw excerpt, `91-extension-e2e-fork.log`:
```
PASS mainnet balance of CrZm5SGo... = 4,378,000,000,000
PASS vault stored sealed (PBKDF2 600k + AES-GCM)
PASS vault refuses a wrong password
PASS fork: vault token account Cb9jn9XGYWgDQ7rjaSiDuEfbcAeCwbr8p7nZWJA9GQBJ funded with 10,000 QC ""
PASS withdraw completed on fork
PASS owner received 1,234.5 QC on the fork
PASS remainder 8,765.5 QC in the next vault
14 passed, 0 failed
EXIT=0 DUR=153s
```
Raw excerpt, `32-proxy-curl.log`:
```
origin chrome-extension://nbchhoognfblfokeiknmgbjghembmona -> 200 {..."amount":"437800000000000000","decimals":5,...
origin https://quantcoin-pi.vercel.app -> 200 {..."amount":"437800000000000000","decimals":5,...
origin https://evil.example -> 403 {"error":"origin not allowed"}
```
Raw excerpt, `51-flutter-test.log`:
```
00:33 +27 -2: Some tests failed.
  .../devnet_send_test.dart: treasury vault -> app vault -> fee wallet, all signed in Dart
  .../ui_send_e2e_test.dart: send through the UI lands on devnet
```

## Failures and findings (unsoftened)

- **F-7:** the extension's first fork e2e run was 13/14. The failing case was the mainnet read through the site proxy, because the proxy refused the extension's `chrome-extension://` origin. The fix added that origin to `web/api/rpc.mjs` and was deployed at 19:12 (by another agent; this pass did not deploy). The re-run above is 14/14 and the curl check returns 200 for that origin.

- **F-1 (test design, not a product fault):** live smoke check "/app/ reached mainnet via /api/rpc/" failed with 0 calls. Cause: `/app/` only calls the RPC after a wallet connects (`App.tsx` `refresh()` returns early without an owner). A follow-up in-page call through the proxy succeeded. The follow-up log also shows one FAIL line caused by a wrong expected constant in the test script; the returned owner `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` is the correct Token-2022 program. This is recorded in the log.
- **F-2:** 2 Flutter devnet tests failed because they need env vars and a devnet key (test-environment). The devnet send path in the native app was **not exercised** in this pass.
- **F-3:** npm audit reports 50 advisories across three projects, including 1 critical (`astro`) and 25 high. **Not fixed, not triaged for reachability.**
- **F-4:** the multisig, pool and position addresses are not published on the transparency page or website, and the time lock is not mentioned there. The position address is not in any checked document.
- **F-5:** `client/verify-mainnet.ts` is stale (old program hash, expects no time lock, old vault list) and would report false failures if a reviewer ran it.
- **F-6:** 10 clippy warnings (style; none affect correctness as reported).

## Not done / skipped

- `cargo audit` (tool not installed).
- iOS and macOS builds: **not built; they need a Mac.**
- Android, Windows and Linux release builds of the Flutter app were not built in this pass (only analyze and tests).
- `apps/native/windows`: not present / not tested (another agent was working on it).
- The Surfpool vault suite ran at `SCALE=0.2` (394 cases) instead of full scale, to fit the time budget.
- Devnet send tests (F-2).

## Limits

- **L-1:** This is internal automated testing, not an external audit. No independent party has reviewed the program.
- **L-2:** Testing cannot prove the absence of bugs. The fuzz and attack cases cover the attacks the authors thought of.
- **L-3:** Mainnet state is a snapshot taken on 2026-10-03; balances can change after it.
- **L-4:** Fork tests run on Surfpool, a simulator of mainnet, and were reduced to 0.2× scale.
- **L-5:** The public RPC throttles requests; checks were run slowly and with retries.
- **L-6:** The history secrets scan looked for keypair arrays and key-file paths. It did not decode every base58 string in every past commit.

## Open items

From `audit/AUDIT-MAINNET-2026-10-03.md`:
- **Q-1 (Critical, operational, open):** key custody does not give the separation a 2-of-3 multisig assumes. Member keys and vault key files (Ed25519 owner + Winternitz master) are not yet stored so that no single device holds two keys; prior finding F5 (plaintext vault secrets) is still open on mainnet.
- **Q-2 (High, open by design):** while the program is upgradeable, every vault is only as quantum-safe as Ed25519. All three multisig members are Ed25519 keys; whoever can sign as two of them can replace the program and move every vault's QC. The 24 h time lock gives warning but does not remove this. Hybrid protection is complete only after the program is made final.
- Windows `.exe` not built (Visual Studio C++ workload missing).
- **No external audit yet.**
- iOS/macOS build needs a Mac.
- F-2 through F-5 above.
