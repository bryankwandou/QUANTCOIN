#!/usr/bin/env bash
# One-command check for reviewers: rebuild the program, compare it byte for byte
# with the binary live on mainnet, and run the test suites.
#
#   bash audit/verify.sh             # build + on-chain hash + tests (~5 min)
#   bash audit/verify.sh --mutants   # also re-run the MT-1 mutants (~30 min)
#   bash audit/verify.sh --clients   # also check the TS client, web app and Android app (~10 min)
#   (flags combine: --clients --mutants)
#
# Needs: solana CLI (Agave 2.x) with cargo build-sbf, Rust, internet access to
# mainnet RPC; for --clients also Node 20+ and Flutter (skipped with a notice if absent).
# Set RPC=<url> to use another endpoint. Exits non-zero on any failure.
set -u
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)" || exit 1
PROGRAM=CiupyGrAtWomKW5rDWbaMEsm3Db8pY8NPECgL2FfACms
EXPECTED=51f64e1a81de78056e886f0d9f55855f56f9e149fb612f9f5f328a8a9100be62
RPC="${RPC:-https://api.mainnet-beta.solana.com}"
M=programs/qc-vault/Cargo.toml
SO=target/deploy/qc_vault.so
TMP="$(mktemp -d)"
fail=0
step() { printf '\n== %s\n' "$1"; }
ok()   { printf 'PASS  %s\n' "$1"; }
bad()  { printf 'FAIL  %s\n' "$1"; fail=1; }

step "commit"
git log -1 --format='%H %s'
git diff --quiet -- programs/ || bad "programs/ has uncommitted changes; results do not describe this commit"

step "build (cargo build-sbf --arch v3)"
if cargo build-sbf --arch v3 --manifest-path "$M" >"$TMP/build.log" 2>&1; then
  local_hash=$(sha256sum "$SO" | cut -c1-64); size=$(wc -c <"$SO" | tr -d ' ')
  echo "local  $local_hash  ($size bytes)"
  [ "$local_hash" = "$EXPECTED" ] && ok "local build = expected live hash" || bad "local build differs from $EXPECTED"
else
  tail -20 "$TMP/build.log"; bad "build failed"; size=0
fi

step "on-chain binary ($RPC)"
if solana program dump -u "$RPC" "$PROGRAM" "$TMP/onchain.so" >/dev/null 2>&1 && [ "$size" -gt 0 ]; then
  chain_hash=$(head -c "$size" "$TMP/onchain.so" | sha256sum | cut -c1-64)
  pad=$(tail -c +"$((size + 1))" "$TMP/onchain.so" | tr -d '\0' | wc -c | tr -d ' ')
  echo "chain  $chain_hash  (first $size bytes; $pad non-zero bytes after them)"
  [ "$chain_hash" = "$local_hash" ] && [ "$pad" = 0 ] && ok "on-chain program = this build" || bad "on-chain program differs from this build"
  solana program show -u "$RPC" "$PROGRAM" 2>/dev/null | grep -E "Authority|Last Deployed"
else
  bad "could not dump the on-chain program (RPC down or build failed)"
fi

step "tests (cargo test --release)"
if cargo test --manifest-path "$M" --release >"$TMP/test.log" 2>&1; then
  grep -E "^test result" "$TMP/test.log"; ok "all test suites"
else
  grep -E "FAILED|panicked|^test result" "$TMP/test.log" | head -30; bad "tests"
fi

case " $* " in *" --clients "*)
  step "client vectors (client/vectors.ts must reproduce audit/test-vectors.txt)"
  (cd client && { [ -d node_modules ] || npm ci --silent; } && npx tsx vectors.ts >/dev/null 2>&1) \
    && git diff --quiet -- audit/test-vectors.txt && ok "TS client = committed vectors (= on-chain code, tests/vectors.rs)" \
    || bad "client/vectors.ts output differs from audit/test-vectors.txt"
  (cd client && npx tsx codama-check.ts) && ok "Codama client = qc.ts" || bad "Codama client differs"

  step "web app tests (app/, vitest)"
  if (cd app && { [ -d node_modules ] || npm ci --silent; } && npx vitest run >"$TMP/app.log" 2>&1); then
    grep -E "Test Files|Tests " "$TMP/app.log"; ok "web app tests"
  else
    grep -E "FAIL|×|Tests " "$TMP/app.log" | head -20; bad "web app tests"
  fi

  step "Android app tests (apps/native, flutter test; devnet-send tests stay skipped)"
  if ! command -v flutter >/dev/null; then
    echo "SKIP  flutter not installed; this step was NOT checked"
  elif (cd apps/native && flutter test >"$TMP/flutter.log" 2>&1); then
    tail -1 "$TMP/flutter.log"; ok "Android app tests"
  else
    grep -E "\[E\]|Some tests failed|Expected|Actual" "$TMP/flutter.log" | head -20; bad "Android app tests"
  fi
  git checkout -q -- apps/native/linux apps/native/macos apps/native/windows 2>/dev/null   # flutter regenerates these
  ;;
esac

case " $* " in *" --mutants "*)
  step "MT-1 mutants (each must be KILLED)"
  OUT="$TMP/mutants.txt" bash audit/mutants-mt1.sh >/dev/null 2>&1
  cat "$TMP/mutants.txt"
  grep -q "SURVIVED\|PATTERN-MISS" "$TMP/mutants.txt" && bad "a mutant survived" || ok "all mutants killed"
  git diff --quiet -- programs/qc-vault/src/lib.rs || bad "lib.rs not restored"
  ;;
esac

step "result"
[ $fail = 0 ] && echo "ALL CHECKS PASSED" || echo "SOME CHECKS FAILED"
rm -rf "$TMP"
exit $fail
