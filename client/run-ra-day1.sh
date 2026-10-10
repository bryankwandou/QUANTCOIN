#!/usr/bin/env bash
# Day 1 (2026-10-11): execute fund proposals #5 and #6 once their time locks end, then extend,
# upload the R-A buffer and open + approve the upgrade proposal (TAG=mainnet-ra), then measure
# real spend latency on the live binary (treasury-9 -> treasury-10, 11 sequential + 10 parallel).
# Every step checks state first, so the script can be re-run safely.
export PATH="/c/nvm4w/nodejs:/c/Users/arche/.local/share/solana/install/active_release/bin:/usr/bin:/mingw64/bin:$PATH"
unset RPC_URL
set -o pipefail   # a failed step must not count as done just because tee succeeded
export QC_NET=mainnet PROGRAM_ID=CiupyGrAtWomKW5rDWbaMEsm3Db8pY8NPECgL2FfACms SO=/e/qc-ra.so \
  PAYER=C:/Users/arche/.config/solana/bersih-mainnet.json
K3=E:/Download/QuantCoin-multisig/kunci-3.json K2=E:/Download/QuantCoin-multisig/kunci-2.json
LOG=/e/Download/QuantCoin-surat/upgrade-log-ra.txt
cd /e/qc-p0/client || exit 1
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$LOG"; }
status() { TAG=$1 npx tsx ra-status.ts 2>/dev/null; }
field() { echo "$1" | tr ' ' '\n' | grep "^$2=" | cut -d= -f2; }

# Run fund proposal TAG once chain time passes its release; returns 0 when executed.
run_fund() {
  local tag=$1
  for i in $(seq 1 600); do
    s=$(status "$tag"); log "$tag: $s"
    case "$s" in Executed*) return 0;; esac
    now=$(field "$s" now); rel=$(field "$s" release)
    if [ -n "$now" ] && [ -n "$rel" ] && [ "$now" -ge "$rel" ]; then
      TAG=$tag MEMBER=$K3 npx tsx upgrade.ts execute 2>&1 | tee -a "$LOG"; sleep 15
    else sleep 60; fi
  done
  return 1
}
short() { npx tsx upgrade.ts plan 2>/dev/null | tee -a "$LOG" | grep -o "deployerShortSol: '[0-9.]*'" | grep -o "[0-9.]*"; }

upgrade_steps() {
  export TAG=mainnet-ra
  npx tsx upgrade.ts extend 2>&1 | tee -a "$LOG" || return 1
  s=$(status mainnet-ra)
  if [ -z "$(field "$s" buffer)" ]; then npx tsx upgrade.ts buffer 2>&1 | tee -a "$LOG" || return 1; fi
  s=$(status mainnet-ra)
  case "$s" in none*) MEMBER=$K3 npx tsx upgrade.ts propose 2>&1 | tee -a "$LOG" || return 1; sleep 10;; esac
  s=$(status mainnet-ra)
  [ "$(field "$s" approvals)" = "1" ] && { MEMBER=$K2 npx tsx upgrade.ts approve 2>&1 | tee -a "$LOG"; sleep 10; }
  s=$(status mainnet-ra); log "upgrade proposal: $s"
  case "$s" in Approved*) return 0;; esac; return 1
}

log "day1 start"
run_fund mainnet-ra-fund || { log "FAILED: #5 not executed"; exit 1; }
up=no   # upgrade steps wait for #6: after #5 alone the deployer clears the estimate by only ~0.0004 SOL
run_fund mainnet-bench-fund || log "WARNING: #6 not executed"
log "deployer short after both: $(short)"
upgrade_steps && up=yes
# Real-spend latency on the binary live today (before the Colosseum deadline); independent of the upgrade.
if [ ! -f bench-day1-done ]; then
  QC_KEYDIR="E:/000VSCODE PROJECT MULAI DARI DESEMBER 2025/QUANTCOIN/client/keys-mainnet"     RPC_URL=https://api.mainnet-beta.solana.com MINT=AsEEaydVYMpghdNTrQoVZTAhJSewZT5xD9WE9hpA68W2     FROM=treasury-9 TREASURY_NEXT=treasury-10 TAG=bench-live PARALLEL=10 REPORT=mainnet-bench-live-2026-10-11     npx tsx mainnet-bench.ts 2>&1 | grep -v deprecated | tee -a "$LOG" && touch bench-day1-done
fi
[ $up = yes ] && log "DAY1 DONE: upgrade proposal approved; day2 executes it after the 24 h lock" || { log "FAILED: upgrade proposal not ready"; exit 1; }
