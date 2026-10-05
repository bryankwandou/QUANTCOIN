# Security Policy

## Reporting a vulnerability

Report privately through GitHub: **Security → Report a vulnerability** on
this repository (private vulnerability reporting). Please do not open a
public issue or pull request for an unfixed vulnerability.

Include the affected file and commit, a reproduction (a LiteSVM test is
ideal; see `programs/qc-vault/tests/vault.rs` for the harness), and the
impact you expect. The maintainer is a single person, so there is no
guaranteed response time. Fixes to the on-chain program go through the
Squads multisig and its 24-hour time lock, so even an urgent fix takes at
least a day to reach mainnet.

## Assurance status

QuantCoin has had a **maintainer-performed internal security review**,
backed by reproducible tests. It has **not** had an independent audit,
and nothing here is a third-party certification.

The current status, the exact release identity (commit, deployed binary
hash, how to reproduce it) and every finding with its state are kept in
one place: [audit/INTERNAL_SECURITY_AUDIT.md](audit/INTERNAL_SECURITY_AUDIT.md).
Older reports in `audit/` are historical records of what was true on their
date.

Pull requests that contain review reports (for example community reports
received through Telegram) are posted by the maintainer. GitHub shows no
reviewer on them; they are inputs to the internal review, not independent
audits. Their findings count only once a test in this repository
reproduces them.

## Scope and assumptions

In scope: the vault program `programs/qc-vault` (`lib.rs`, `wots.rs`), the
clients that build and sign spends (`client/`, `app/`, `apps/native/`),
and the mainnet deployment of program
`CiupyGrAtWomKW5rDWbaMEsm3Db8pY8NPECgL2FfACms` and mint
`AsEEaydVYMpghdNTrQoVZTAhJSewZT5xD9WE9hpA68W2`.

Outside the scope of this protocol review: the Solana runtime, the
Token-2022, Associated Token Account, Memo and Squads programs. Their
behaviour is treated as a dependency, and the assumptions made about it are
written down in the audit report.

The vault is designed for the QC mint, whose mint, freeze and metadata
authorities are revoked and which has no transfer hook, transfer fee or
permanent delegate. It is **not** a safe vault for arbitrary Token-2022
mints.

## Operational security

- A vault's Winternitz key signs exactly one message. Clients record the
  digest before broadcasting and refuse to sign anything else.
- Vault key files must be kept in encrypted offline storage with
  independent backups. On the operator machine this is not done yet (see
  finding F5/Q-1 in the audit report).
- The program is upgradeable by a Squads v4 2-of-3 multisig
  (`A9tdTp68GVvGVLherFjDUgJptoHMWja5r4uWH5DFou2P`, 24-hour time lock).
  Whoever controls two member keys can replace the program.
