# Hendra Saputra - client/app/script test report
Worktree E:/qc-pr1-D, HEAD 883c0ec. Start 2026-10-05T14:08:52+08:00, end ~14:17+08:00. Local only: no commit/push, no RPC. Raw output: quantcoin-vault-review/client-tests-output.txt

## Commands and results
| Package | Command | Result |
|---|---|---|
| app | npx vitest run test/audit2.test.ts test/equivalence.test.ts test/store.test.ts | exit 0; 3 files, 10 tests passed |
| app | npx tsc --noEmit -p tsconfig.json | exit 0 |
| client | npx tsx codama-check.ts (package "test") | exit 0; "codama client matches qc.ts: 650-byte data, 9 accounts" (1 check, 0 failed) |
| client | tsc --noEmit with ad-hoc flags (no tsconfig exists) | exit 2: only TS2307 for node:crypto/fs/url (no @types/node in client); not real code errors |
| client | npx tsx codama.ts (drift regen) | exit 0 |
| scripts | none runnable: scripts/ holds only backup-keys.sh, restore-keys.sh (not opened, key-related; not run) | n/a |
| lint | no eslint config or dependency in any package | not run; 0 tests/lint counts |

## Skipped (need live RPC)
- client/surfpool-suite.ts: needs Surfpool mainnet fork (SURF_RPC).
- client/verify-mainnet.ts, audit-mainnet.ts, audit-devnet.ts, state-check.ts, squads-timelock.ts, upgrade.ts, rent-probe.ts, claim-fees.ts, launch-pool.ts, return-prep.ts, spend.ts: use Connection/RPC (devnet/mainnet); not all opened individually, selected by grep for Connection/fetch/surfpool and names.
- app/scripts/roundtrip.ts: Connection to RPC_URL or api.devnet.solana.com, needs PAYER keypair.
- app/test/*.test.ts: no network use; all run.

## Finding: codama drift "modified" files
- core.autocrlf=true, no .gitattributes. Index blobs are LF (i/lf); codama.ts writes LF files (w/lf). Git warns "LF will be replaced by CRLF", keeps those entries stat-dirty, so `git status` lists 16 files as M (8 client/generated, 7 apps/native flutter generated; 1 more client file index counted) while `git diff --exit-code` returns 0 (content equal after normalization; also empty with --ignore-cr-at-eol). So no real drift: line-ending/stat artifact only.
- The tree was already showing these 16 as M before my run (the flutter ones are not touched by codama).
- Restore: `git checkout -- <the 16 files>` rewrites them as CRLF in worktree; git status now clean. Any later `npx tsx codama.ts` will reproduce the phantom M. Suggest `.gitattributes` (`client/generated/** text eol=lf`) or check drift with `git diff --exit-code` only.

## Other notes
- app tsc -b was avoided (would modify tsconfig.tsbuildinfo); used --noEmit.
