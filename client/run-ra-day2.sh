#!/usr/bin/env bash
# Day 2: execute the approved R-A upgrade once its time lock ends, verify the deployed hash
# (dd3495ee…), then measure real spend latency (treasury-9 -> bench vaults).
export PATH="/c/nvm4w/nodejs:/c/Users/arche/.local/share/solana/install/active_release/bin:/usr/bin:/mingw64/bin:$PATH"
unset RPC_URL
export QC_NET=mainnet PROGRAM_ID=CiupyGrAtWomKW5rDWbaMEsm3Db8pY8NPECgL2FfACms SO=/e/qc-ra.so \
  PAYER=C:/Users/arche/.config/solana/bersih-mainnet.json TAG=mainnet-ra
K3=E:/Download/QuantCoin-multisig/kunci-3.json
LOG=/e/Download/QuantCoin-surat/upgrade-log-ra.txt
cd /e/qc-p0/client || exit 1
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$LOG"; }
field() { echo "$1" | tr ' ' '\n' | grep "^$2=" | cut -d= -f2; }
verified() { npx tsx upgrade.ts verify 2>&1 | tee -a "$LOG" | grep -q "deployedMatchesSo: true"; }

log "day2 start"
for i in $(seq 1 720); do
  verified && break
  s=$(npx tsx ra-status.ts 2>/dev/null); log "upgrade: $s"
  now=$(field "$s" now); rel=$(field "$s" release)
  case "$s" in Approved*) if [ "$now" -ge "$rel" ]; then MEMBER=$K3 npx tsx upgrade.ts execute 2>&1 | tee -a "$LOG"; sleep 20; continue; fi;; esac
  sleep 60
done
verified || { log "FAILED: upgrade not deployed"; exit 1; }
log "UPGRADE DONE: deployed program = dd3495ee…4acb"
[ -f bench-done ] && exit 0
QC_KEYDIR="E:/000VSCODE PROJECT MULAI DARI DESEMBER 2025/QUANTCOIN/client/keys-mainnet" \
  RPC_URL=https://api.mainnet-beta.solana.com MINT=AsEEaydVYMpghdNTrQoVZTAhJSewZT5xD9WE9hpA68W2 \
  FROM=treasury-9 TREASURY_NEXT=treasury-10 TAG=bench-ra N=5 REPORT=mainnet-bench-RA \
  npx tsx mainnet-bench.ts 2>&1 | grep -v deprecated | tee -a "$LOG" && touch bench-done
log "day2 finished"
