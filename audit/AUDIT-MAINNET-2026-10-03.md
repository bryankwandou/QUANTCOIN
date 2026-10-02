# QuantCoin mainnet: internal automated review (2026-10-03)

**This is not an external audit.** It was done by the project's own AI
tooling. It does not replace a review by an independent firm, and QC must
not be described as "audited" on the strength of it. The program stays
upgradeable through the Squads 2-of-3 multisig until an external audit is
done and its findings are fixed.

## Scope

- Program `CiupyGrAtWomKW5rDWbaMEsm3Db8pY8NPECgL2FfACms`
  (`programs/qc-vault/src/lib.rs`, `wots.rs`)
- Mint `AsEEaydVYMpghdNTrQoVZTAhJSewZT5xD9WE9hpA68W2`
- Upgrade authority: Squads multisig `A9tdTp68GVvGVLherFjDUgJptoHMWja5r4uWH5DFou2P`
  (vault `45nAvRrgqxkdnsDmW9dmukHNcxE1TM5PnJsH27cTXxez`)
- QC/SOL pool `AyS1vByiVFsVdsekRZE1mGVY5MHY1YMs59DeGwDwbbwB`
- Quantum Safe web app (`app/`), site RPC proxy (`web/api/rpc.mjs`)

## Verdict

No way was found to move QC out of a vault without both the owner's Ed25519
key and the vault's Winternitz key. The largest risks are not in the
program code. They are in who can replace the code (Q-1, Q-2, Q-3).

## Verified

| Check | Result |
|---|---|
| Deployed program equals the source in this repo | Rebuilt with `cargo build-sbf`: sha256 `07e6b6dd45e6bb7f…`, identical to the on-chain bytes (rest is zero padding) |
| Mint authorities | Mint, freeze and metadata update authority all disabled. Extensions: metadata pointer and metadata only. No transfer fee, transfer hook or permanent delegate |
| Program tests | 27/27 pass, including fuzzed signature mutation, account substitution, replay after spend (M-1), decoy token account (F9) |
| WOTS construction | Checksum prevents digit domination; every hash input has a fixed length and its own domain tag; per-vault seed tweaks every chain step |
| Account checks | 9 distinct accounts; vault token account must be the PDA's Token-2022 ATA; token and system program pinned; digest binds program, vault, mint, destination, refund, rent receiver, amount |
| One-time rule | Vault is assigned to the program after its spend and refused forever; a 170-byte ATA's rent always covers the 0-byte marker at any rent rate |
| Quantum Safe app | Mainnet-fork round trip passes (deposit, spend, rotate, refuse reuse); secrets sealed with PBKDF2-SHA256 600k + AES-256-GCM, bound to owner and vault |
| Pool | Project position 7Bqgd7Ay…: locked liquidity 100%, unlocked 0. A second, unlocked position belongs to an outside liquidity provider |
| Fair launch | 9 distinct signers traded in the pool; none is a project key. The only project transaction is the pool creation |

## Findings

### Q-1: Key custody does not give the separation a 2-of-3 multisig assumes. Critical (operational). Open.
The multisig only protects the program if no single device or place holds
two of its keys. How the member keys and the vault key files (Ed25519
owner + Winternitz master) are stored does not meet that bar yet, and
prior finding F5 is still open on mainnet. Details are kept private until
fixed. **Action:** move member keys to separate devices or offline paper,
encrypt vault key files at rest, keep two offline backups.

### Q-2: While the program is upgradeable, every vault is only as quantum-safe as Ed25519. High. Open by design.
All three multisig members are Ed25519 keys. Whoever can sign as two of
them, including a future quantum attacker, can replace the program and
move every vault's QC. The hybrid protection is complete only after
`--final`. **Action:** say so wherever quantum resistance is claimed; make
the program final after the external audit (prior finding F6).

### Q-3: Squads time lock was 0. Medium. Fixed 2026-10-03.
An approved upgrade executes immediately. Holders get no window to see it
and react. **Action:** set a time lock (24–72 hours) through a multisig
config transaction. Trade-off: an emergency fix also waits that long.
**Fixed:** time lock set to 86,400 s (24 h), tx `whoiuHmoWetoYcRQqgbTq9KfZkfdyVEEGjq9e2wLna7wHGazRi8ASTR2PeyLqRbJuQtxYitWLiD4hXMXEjH3vtw`.

### Q-4: The site RPC proxy was an open relay. Low. Mitigated 2026-10-03.
`/api/rpc/` answers any origin and forwards `sendTransaction` without rate
limits. Heavy outside use could get the upstream RPC to throttle the site,
which would break the dashboard and Quantum Safe. Keys never pass through
it. **Action:** limit by origin and rate, or use a keyed RPC upstream.
**Mitigated:** browsers on other sites are now refused (origin allowlist).
Non-browser clients can still call it; a keyed upstream remains the full fix.

### Q-5: Dependency advisories. Low.
`web/`: astro 5.x has critical advisories (XSS in user-supplied
attributes, SSR-only issues, image optimisation). The site is static and
renders only its own content, so none is reachable today; upgrade anyway.
`app/` and `client/`: `bigint-buffer` (via `@solana/spl-token`) can be
crashed by malformed data; impact is a client-side error, not key loss.

### Q-6: Pool fees are claimable by a hot wallet. Low. Handled 2026-10-03.
The project position's fees (2.62 SOL unclaimed on 2026-10-03, mostly
anti-sniper fees) are claimable by the deployer wallet, which is a normal
key on the operator's machine. Locked liquidity itself cannot be taken.
**Action:** claim and move fees to the Squads vault, as LAUNCH.md §3
commits, and publish the transactions.
**Done:** 2.620269753 SOL claimed and forwarded to the Squads vault in one
transaction, tx `4iJGQsCYQ6Ga7wozXSbDhRYG92cMTmcZgq5NnwYyh22NLsVxH6XaEGiUoy2XekiJAwNG578x5Nci6gatdREoV8xx`.

### I-1: Non-canonical bumps are accepted. Informational.
The program checks the vault address with the bump from instruction data.
One Winternitz key could therefore control up to 256 addresses, and
spending two of them would reuse the one-time key. No exploit: every spend
still needs the owner's Ed25519 signature, and both clients derive only
the canonical address.

### I-2: Generic Token-2022 mints. Informational (roadmap item 6).
The program accepts any Token-2022 mint. Tokens of a mint with a transfer
hook cannot be spent (the hook's extra accounts cannot be passed) and stay
locked; a permanent delegate can move tokens out of any vault; withheld
transfer fees block the close until harvested (tested). QC has none of
these extensions. A generic vault must refuse such mints.

### I-3: Entrypoint comment says eight accounts; the code reads nine. Informational.
Left unchanged so the source keeps matching the deployed binary
byte for byte; fix with the next upgrade.

## Status of earlier findings

| ID | Status on mainnet |
|---|---|
| F1–F3, F7, F8 | Unchanged from `AUDIT.md` |
| F4 (192-bit digest) | Accepted, low |
| F5 (plaintext vault secrets) | **Still open** (see Q-1) |
| F6 (upgrade authority) | Moved to Squads 2-of-3; not final until the external audit |
| M-1, F9 | Fixed; regression tests pass |

## Reproduce

```bash
cargo test -p qc-vault --release                 # 27 tests
cargo build-sbf --manifest-path programs/qc-vault/Cargo.toml
solana program dump -um CiupyGrAtWomKW5rDWbaMEsm3Db8pY8NPECgL2FfACms onchain.so
# compare sha256 of the first 7456 bytes of onchain.so with target/deploy/qc_vault.so
spl-token -um display AsEEaydVYMpghdNTrQoVZTAhJSewZT5xD9WE9hpA68W2
```
