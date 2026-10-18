#!/usr/bin/env bash
# Re-runs the PR #14 surviving mutants against the current tests. Each mutant is
# one exact text replacement in lib.rs; lib.rs is restored from git after each.
export PATH="/c/Users/arche/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)" || exit 1
LIB=programs/qc-vault/src/lib.rs
M=programs/qc-vault/Cargo.toml
OUT="${OUT:-audit/mutants-mt1-run.txt}"
: > "$OUT"
mut() { # id, old, new
  node -e '
    const fs=require("fs"),[f,a,b]=process.argv.slice(1);
    let s=fs.readFileSync(f,"utf8").replace(/\r\n/g,"\n");
    if(s.split(a).length!==2){console.error("MISS");process.exit(3)}
    fs.writeFileSync(f,s.replace(a,b));' "$LIB" "$2" "$3" || { echo "$1 PATTERN-MISS" | tee -a "$OUT"; git checkout -q -- "$LIB"; return; }
  if ! cargo build-sbf --arch v3 --manifest-path $M >/dev/null 2>&1; then
    echo "$1 KILLED (does not compile)" | tee -a "$OUT"; git checkout -q -- "$LIB"; return; fi
  fails=$( { cargo test --manifest-path $M --release --test vault 2>&1; \
             cargo test --manifest-path $M --release --test fuzz rejects_fake_system_program 2>&1; } \
           | grep -E "^test .* FAILED$" | sed 's/^test //; s/ \.\.\. FAILED//' | tr '\n' ' ')
  if [ -n "$fails" ]; then echo "$1 KILLED by: $fails" | tee -a "$OUT"; else echo "$1 SURVIVED" | tee -a "$OUT"; fi
  git checkout -q -- "$LIB"
}
mut M02 $'    if system.address() != &SYSTEM {\n        return Err(VaultError::BadInstruction);\n    }\n' ''
mut M09 $'        mint,\n        destination,\n        refund,' $'        destination,\n        refund,'
mut M13 $'        wots::DOMAIN_MSG,\n        program_id,\n' $'        wots::DOMAIN_MSG,\n'
mut M14 $'        program_id,\n        vault,\n        mint,\n        destination,' $'        program_id,\n        mint,\n        destination,'
mut M17 'if amount > 0 {' 'if amount > 1 {'
mut M18 'if rest > 0 {' 'if rest > 1 {'
mut M20 ' || data[0] != IX_SPEND' ''
mut M22-mint ' || mint.data_len() < 45' ''
mut M22-ta 'vault_ta.data_len() < 72 || ' ''
git checkout -q -- "$LIB"
cargo build-sbf --arch v3 --manifest-path $M >/dev/null 2>&1
echo "clean rebuild: $(sha256sum target/deploy/qc_vault.so | cut -c1-64)" | tee -a "$OUT"
git status --short "$LIB" | tee -a "$OUT"
