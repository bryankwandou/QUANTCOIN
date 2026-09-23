# QuantCoin internal security audit (devnet)

Date: 2026-09-23. Scope: `programs/qc-vault` (lib.rs, wots.rs), `client/qc.ts`,
`client/genesis.ts`, `client/spend.ts`, the devnet mint and program.

**This is an internal review, not an independent audit.** It was done by
the same party that wrote the code. Mainnet still needs an external audit.

## Verdict

No finding lets anyone move vault funds without both the owner's Ed25519
key and the vault's Winternitz key. One test-quality issue was fixed and one
client issue (funds could be locked) was fixed. Five items remain as
accepted risks or pre-mainnet actions (below).

## What was verified

| Check | How | Result |
|---|---|---|
| Deployed devnet binary = audited source | `solana program dump`, SHA-256 compared with a fresh `cargo build-sbf` | identical, `0462c658…730b`, 6,872 B |
| Mint cannot be inflated / frozen / edited | `spl-token display` on devnet | mint, freeze, metadata-pointer, metadata update authority all unset |
| Supply | same | 22,000,000,000,000 QC (2.2×10¹⁸ base units, 5 decimals) |
| Local attack tests | LiteSVM + real Token-2022, each asserts the **exact** error code | 12/12 pass |
| Live attacks on devnet | `client/audit-devnet.ts`, real on-chain transactions | 13/13 blocked, vault balance unchanged, attacker received 0 |
| Worst-case compute | measured CU per hash step × 6,375 max steps | ~1.09M of 1.4M cap |
| Transaction size | serialized spend tx | 1,124 of 1,232 bytes |
| Rust ⇄ TypeScript agreement | real devnet spends signed in TS, verified on-chain in Rust; Codama client byte-identical | agree |

Live attack log with every transaction signature: `audit/devnet-attack-run.json`.

| Attack on devnet | Error returned |
|---|---|
| WOTS signature without the Ed25519 owner signature | 7 MissingOwnerSignature |
| Thief substitutes their own owner key | 2 BadSignature |
| Redirect destination / refund / rent to attacker | 2 BadSignature |
| Raise amount after signing | 2 BadSignature |
| Flip one signature bit, change WOTS seed, wrong bump | 2 BadSignature |
| Legacy SPL Token program instead of Token-2022 | 5 BadTokenProgram |
| destination = refund | 6 DuplicateAccount |
| Truncated instruction data | 1 BadInstruction |
| Replay of an executed spend | 4 NotATokenAccount (vault account closed) |

## Findings

### F1: Negative tests passed for the wrong reason. Fixed.
Four tests (`rejects_wrong_owner`, `rejects_redirected_destination`,
`rejects_overspend`, `rejects_missing_owner_signature`) used the same
account as destination and refund. The program rejects that first
(DuplicateAccount), so the check each test claimed to cover was never
reached. They only asserted "some error". **Fix:** distinct accounts, and
every negative test now asserts the specific error code. Added tests for
duplicate accounts, wrong token program, replay, and tampered
signature/seed/length.

### F2: A failed broadcast could lock a vault forever. Fixed.
`spend.ts` marked the key `used` before sending. If the transaction then
failed (RPC error, expired blockhash), the client refused to sign again, and
the funds had no way out. **Fix:** the key file records the exact digest it
signed. Signing the *same* digest again produces the identical signature
(no new information leaks), so retries are allowed. Any *different* message
is refused.

### F3: Tokens sent to an already-spent vault are stuck. Accepted, documented.
The vault address is deterministic. After a spend, anyone can recreate its
token account and send QC there. Recovering it would need a second WOTS
signature with the same key, which weakens that key. Pre-quantum the owner
signature still protects it; post-quantum, two signatures from one key can
let an attacker forge a third. **Action:** wallets must never show a spent
vault as a deposit address. Treat the address as burned.

### F4: 192-bit message digest; quantum collision cost ~2⁶⁴. Low.
Security against a third party is second-preimage (~2⁹⁶ with Grover). A
collision attack only matters if an attacker chooses what the owner signs
(for example a malicious dApp asking the owner to sign a crafted message).
The owner only signs spends their own client builds. **Action:** never
sign vault spends built by third parties. Increasing the digest to 32 bytes
would cost more signature size, and the transaction has 108 bytes left.

### F5: Vault secrets are stored in plaintext. High (operational).
`client/keys/*.json` holds both keys unencrypted. Anyone with disk access
takes the vault. **Action before mainnet:** generate mainnet vault keys on
an offline machine, encrypt them at rest, and keep two offline backups.
Losing either key locks the funds forever.

### F6: Upgrade authority still set on devnet. Pre-mainnet action.
Devnet program upgrade authority is `AUo5…95AG7`. Whoever holds an upgrade
key can replace the program and drain every vault; after a quantum break
that is anyone. **Action:** on mainnet, deploy then immediately run
`solana program set-upgrade-authority <id> --final`. This also makes any
future bug unfixable, which is why the external audit comes first.

### F7: Unchecked reads of mint and vault token account data. Informational, safe.
The program reads balance and decimals without checking account owners. A
fake account can only report a fake balance or decimals. Token-2022 then
re-validates everything in `TransferChecked` and `CloseAccount`, and the
PDA only signs for accounts Token-2022 recognises. Confirmed by the live
wrong-token-program attack.

### F8: Compute headroom. Informational.
Worst case ~1.09M CU against a 1.4M cap (22% headroom). A future
Solana change to `sol_sha256` pricing could shrink this. Re-measure on
mainnet with a test spend before moving the treasury.

## Cryptographic review notes

- WOTS w=256, n=192 bits, 24+2 chains; checksum max 6,120 fits 2 base-256
  digits, and lowering any message digit raises the checksum, so a single
  signature cannot be forged by moving chains forward.
- Every hash is domain-separated (`QCV1/chain|pk|msg|sk`) and tweaked with
  (public seed, chain index, step), which blocks multi-target attacks across
  keys and chain positions.
- The signed digest binds program id, vault, mint, destination, refund, rent
  receiver and amount. Mainnet uses a different mint, so a devnet signature
  cannot be replayed on mainnet even if the program id is the same.
- On-chain SHA-256 is the `sol_sha256` syscall; off-chain is `sha2` (Rust)
  and `node:crypto` (TS). All three agree, proven by live spends.

## Out of scope / limits

- QC held in normal wallets is protected only by Ed25519. No token can
  change that. Only QC inside hybrid vaults is quantum-resistant.
- Token-2022 and the Solana runtime themselves were not audited.
- No fuzzing or formal verification was done. Recommended for the external
  auditor: fuzz `recover_pk_hash` and the instruction parser, and review the
  `unsafe` pointer reads in `lib.rs` and `wots.rs`.

## Reproduce

```bash
cargo build-sbf --manifest-path programs/qc-vault/Cargo.toml
cargo test --manifest-path programs/qc-vault/Cargo.toml --release   # 12/12
cd client && npm test                                                  # Codama client check
RPC_URL=… PAYER=… PROGRAM_ID=… MINT=… FROM=<treasury> NEXT=<new> npx tsx audit-devnet.ts
```
