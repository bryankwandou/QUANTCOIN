#!/usr/bin/env bash
# Decrypts a backup from bryankwandou/quantcoin-keys-backup into client/keys/.
# Usage: bash scripts/restore-keys.sh qc-keys-<stamp>.tar.gz.enc
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f "$1" ] || { echo "usage: $0 <file.enc>"; exit 1; }
[ ! -e client/keys ] || { echo "client/keys/ exists; move it away first"; exit 1; }
read -rsp "Passphrase: " P; echo
printf %s "$P" | openssl enc -d -aes-256-cbc -pbkdf2 -iter 1000000 -pass stdin -in "$1" | tar -xzf -
unset P
ls client/keys
