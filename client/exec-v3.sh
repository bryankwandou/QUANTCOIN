#!/usr/bin/env bash
# Executor for Squads proposal #8 (qc-vault rebuilt as SBPF v3, same source as R-A), run by
# Windows Task Scheduler. Refuses to run unless the mainnet-fork suites passed on the v3 binary
# (gate file written only after they did). Waits for the on-chain clock to pass the time lock,
# runs the approved proposal, verifies the deployed hash. Safe to run twice: verify comes first.
export PATH="/c/nvm4w/nodejs:/c/Users/arche/.local/share/solana/install/active_release/bin:/usr/bin:/mingw64/bin:$PATH"
unset RPC_URL
export QC_NET=mainnet PROGRAM_ID=CiupyGrAtWomKW5rDWbaMEsm3Db8pY8NPECgL2FfACms \
  PAYER=C:/Users/arche/.config/solana/bersih-mainnet.json SO=/e/qc-v3.so TAG=mainnet-v3 \
  MEMBER=E:/Download/QuantCoin-multisig/kunci-3.json
RELEASE=1792243436   # 2026-10-17 13:23:56 UTC = 21:23:56 WITA
GATE=/e/qc-p0/audit/v3-fork-gate-ok.txt
LOG=/e/Download/QuantCoin-surat/upgrade-log-v3.txt
cd /e/qc-p0/client || exit 1
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$LOG"; }
done_check() { npx tsx upgrade.ts verify 2>&1 | tee -a "$LOG" | grep -q "deployedMatchesSo: true"; }

log "v3 executor start"
if [ "$(sha256sum /e/qc-v3.so | cut -c1-64)" != "51f64e1a81de78056e886f0d9f55855f56f9e149fb612f9f5f328a8a9100be62" ]; then
  log "ABORT: /e/qc-v3.so is not the approved binary"; exit 1
fi
if done_check; then log "DONE: deployed program already matches 51f64e1a"; exit 0; fi
if [ ! -f "$GATE" ]; then log "ABORT: fork suites have not passed on v3 (no $GATE); not executing"; exit 1; fi
for i in $(seq 1 240); do   # up to ~4 h of waiting / retrying
  if done_check; then log "DONE: deployed program matches 51f64e1a"; exit 0; fi
  now=$(solana block-time -um "$(solana slot -um 2>/dev/null)" --output json 2>/dev/null | grep -o '"timestamp": *[0-9]*' | grep -o '[0-9]*$')
  if [ -z "$now" ] || [ "$now" -lt "$RELEASE" ]; then log "chain time ${now:-unknown} < $RELEASE, waiting"; sleep 60; continue; fi
  log "chain time $now >= release, executing proposal #8 (attempt $i)"
  npx tsx upgrade.ts execute 2>&1 | tee -a "$LOG"
  sleep 20
done
done_check && { log "DONE"; exit 0; }
log "FAILED: not executed after all attempts"; exit 1
