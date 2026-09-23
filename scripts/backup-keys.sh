#!/usr/bin/env bash
# Encrypts client/keys/ and pushes the ciphertext to the PRIVATE repo
# bryankwandou/quantcoin-keys-backup. The passphrase is typed by you and never
# stored anywhere. Without it the backup is useless, so write it on paper.
# Run in Git Bash:  bash scripts/backup-keys.sh
# Restore:          bash scripts/restore-keys.sh <file.enc>
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=https://github.com/bryankwandou/quantcoin-keys-backup.git
[ -d client/keys ] || { echo "no client/keys/"; exit 1; }

read -rsp "Passphrase (min 16 chars): " P1; echo
read -rsp "Repeat passphrase: " P2; echo
[ "$P1" = "$P2" ] || { echo "passphrases differ"; exit 1; }
[ ${#P1} -ge 16 ] || { echo "too short"; exit 1; }

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
OUT="$TMP/qc-keys-$STAMP.tar.gz.enc"
tar -czf "$TMP/keys.tgz" client/keys $( [ -f client/genesis.json ] && echo client/genesis.json )
printf %s "$P1" | openssl enc -aes-256-cbc -pbkdf2 -iter 1000000 -salt -pass stdin -in "$TMP/keys.tgz" -out "$OUT"
# Prove it decrypts to the same bytes before trusting it.
printf %s "$P1" | openssl enc -d -aes-256-cbc -pbkdf2 -iter 1000000 -pass stdin -in "$OUT" | cmp - "$TMP/keys.tgz"
unset P1 P2
SUM=$(sha256sum "$OUT" | cut -d' ' -f1)

git clone -q "$REPO" "$TMP/repo" 2>/dev/null || { mkdir "$TMP/repo"; git -C "$TMP/repo" init -q -b main; git -C "$TMP/repo" remote add origin "$REPO"; }
cp "$OUT" "$TMP/repo/"
echo "$SUM  $(basename "$OUT")" >> "$TMP/repo/SHA256SUMS"
[ -f "$TMP/repo/README.md" ] || cat > "$TMP/repo/README.md" <<'EOF'
# QuantCoin key backups (encrypted)

Each `.enc` file is `tar.gz` of `client/keys/` encrypted with
`openssl enc -aes-256-cbc -pbkdf2 -iter 1000000`. The passphrase is NOT
stored anywhere online. Restore with `scripts/restore-keys.sh` from the
public QUANTCOIN repo. Keep this repository private.
EOF
git -C "$TMP/repo" add -A
git -C "$TMP/repo" commit -qm "backup $STAMP"
git -C "$TMP/repo" push -q origin HEAD:main
echo "pushed $(basename "$OUT")  sha256 $SUM"
