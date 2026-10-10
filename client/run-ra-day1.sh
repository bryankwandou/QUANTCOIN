#!/usr/bin/env bash
# 2026-10-11, all in one: the R-A upgrade proposal #7 (buffer FEfY2Mfz…, sha dd3495ee…) was opened and
# approved on 2026-10-10 08:25Z, so its time lock ends 2026-10-11 08:25:37Z. This script:
#   1. executes fund proposal #5 (02:29Z) and extends the program data account with it,
#   2. executes fund proposal #6 (08:09Z),
#   3. executes upgrade #7 (08:25Z) and verifies the deployed hash,
#   4. measures real spend latency on the new binary (11 sequential + 10 parallel spends).
# Every step checks chain state first, so the script can be re-run safely.
export PATH="/c/nvm4w/nodejs:/c/Users/arche/.local/share/solana/install/active_release/bin:/usr/bin:/mingw64/bin:$PATH"
unset RPC_URL
set -o pipefail   # a failed step must not count as done just because tee succeeded
export QC_NET=mainnet PROGRAM_ID=CiupyGrAtWomKW5rDWbaMEsm3Db8pY8NPECgL2FfACms SO=/e/qc-ra.so \
  PAYER=C:/Users/arche/.config/solana/bersih-mainnet.json
K3=E:/Download/QuantCoin-multisig/kunci-3.json
LOG=/e/Download/QuantCoin-surat/upgrade-log-ra.txt
cd /e/qc-p0/client || exit 1
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$LOG"; }
status() { TAG=$1 npx tsx ra-status.ts 2>/dev/null; }
field() { echo "$1" | tr ' ' '\n' | grep "^$2=" | cut -d= -f2; }
verified() { TAG=mainnet-ra npx tsx upgrade.ts verify 2>&1 | tee -a "$LOG" | grep -q "deployedMatchesSo: true"; }

# Execute the proposal recorded under TAG once chain time passes its release.
run_proposal() {
  local tag=$1
  for i in $(seq 1 720); do
    [ "$tag" = mainnet-ra ] && verified && return 0
    s=$(status "$tag"); log "$tag: $s"
    case "$s" in Executed*) return 0;; esac
    now=$(field "$s" now); rel=$(field "$s" release)
    if [ -n "$now" ] && [ -n "$rel" ] && [ "$now" -ge "$rel" ]; then
      TAG=$tag MEMBER=$K3 npx tsx upgrade.ts execute 2>&1 | tee -a "$LOG"; sleep 15
    else sleep 60; fi
  done
  return 1
}

log "day1 (all in one) start"
run_proposal mainnet-ra-fund || log "WARNING: #5 not executed"
TAG=mainnet-ra npx tsx upgrade.ts extend 2>&1 | tee -a "$LOG" || log "WARNING: extend failed (retried after #6)"
run_proposal mainnet-bench-fund || log "WARNING: #6 not executed"
TAG=mainnet-ra npx tsx upgrade.ts extend 2>&1 | tee -a "$LOG" || { log "FAILED: extend"; exit 1; }
run_proposal mainnet-ra || { log "FAILED: upgrade #7 not executed"; exit 1; }
verified || { log "FAILED: deployed bytes differ"; exit 1; }
log "UPGRADE DONE: deployed program = dd3495ee…4acb"
# The cloud executor (github.com/bryankwandou/qc-ra-executor) runs the same bench from the same
# pre-signed treasury spend; the laptop waits 20 min and runs it only if treasury-9 is still unspent.
sleep 1200
if [ ! -f bench-day1-done ] && ! curl -s https://api.mainnet-beta.solana.com -X POST -H "content-type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo","params":["Hh8dMAjFfYEdfcj2xnT3s52DonzFL2gt5KEUDVezvA2h",{"encoding":"base64"}]}' \
    | grep -q CiupyGrAtWomKW5rDWbaMEsm3Db8pY8NPECgL2FfACms; then
  QC_KEYDIR="E:/000VSCODE PROJECT MULAI DARI DESEMBER 2025/QUANTCOIN/client/keys-mainnet" \
    RPC_URL=https://api.mainnet-beta.solana.com MINT=AsEEaydVYMpghdNTrQoVZTAhJSewZT5xD9WE9hpA68W2 \
    FROM=treasury-9 TREASURY_NEXT=treasury-10 TAG=bench-ra PARALLEL=10 REPORT=mainnet-bench-RA-2026-10-11 \
    npx tsx mainnet-bench.ts 2>&1 | grep -v deprecated | tee -a "$LOG" && touch bench-day1-done
fi
log "day1 finished"
