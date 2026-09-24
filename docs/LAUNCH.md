# QuantCoin launch plan

The ten trust commitments, what each one needs, and its status. Nothing
here happens on mainnet until item 1 is done.

| # | Commitment | Status |
|---|---|---|
| 1 | External audit, report published | Scope ready (below); auditor not yet hired |
| 2 | Program `--final`, every authority revoked | Authorities revoked on devnet; `--final` runs at mainnet deploy |
| 3 | LP tokens burned | Runbook below; mainnet only |
| 4 | Live transparency dashboard | `transparency/index.html` |
| 5 | Fair launch | Policy below |
| 6 | Quantum Safe app | `app/` (devnet) |
| 7 | Airdrop to real users | Policy below |
| 8 | Public bug bounty vault | Live on devnet: `D4k27sCwemEeU73tiATQDn2YKuhwoAqWedXWiBQuYjeE`, 1,000,000,000 QC |
| 9 | Known founder identity | Founder's decision (below) |
| 10 | Honest communication | Rules below |

## 1. External audit

**Scope** (about 700 lines of Rust):

- `programs/qc-vault/src/lib.rs`: instruction parsing, account checks,
  manual CPIs into Token-2022, `unsafe` pointer reads.
- `programs/qc-vault/src/wots.rs`: WOTS verification, checksum, domain
  separation.
- `client/qc.ts`: off-chain signing, one-time key enforcement.

**Questions for the auditor:**

1. Can funds move without both the Ed25519 and the WOTS signature?
2. Is the WOTS construction (w=256, n=192, 24+2 chains) sound, and is ~96-bit
   post-quantum security a fair claim?
3. Are the `unsafe` reads bounded for every input length?
4. Is there any input that exceeds 1.4M CU and locks a vault?
5. Is the one-time key rule in the client enough?

**Provide:** this repo, `audit/AUDIT.md`, `audit/devnet-attack-run.json`, the
devnet program ID.

**Candidates:** OtterSec, Neodyme, Zellic, Sec3, Accretion, Halborn. Ask two
or three for quotes. Expect roughly USD 5,000–30,000 for this size. The
reserve vault covers it.

## 2. Mainnet deploy runbook

```bash
solana program deploy target/deploy/qc_vault.so --keypair <deployer>   # ~0.036 SOL + refundable buffer
solana program set-upgrade-authority <PROGRAM_ID> --final
npx tsx client/genesis.ts        # mint, metadata, full supply into vault, revoke authorities
npx tsx client/allocate.ts       # split into the five allocation vaults
npx tsx client/audit-devnet.ts   # optional: small live attack run on mainnet with a tiny vault
```

Afterwards, verify publicly: `solana program show <ID>` shows no upgrade
authority, and `spl-token display <MINT>` shows no mint, freeze or metadata
authority. Put the explorer links on the dashboard.

## 3. Liquidity and LP burn

1. Spend from the liquidity vault to a fresh launch wallet (one hybrid
   spend).
2. Create a Raydium CPMM (Token-2022 supported) pool with QC and SOL. The
   pool's starting ratio sets the launch price. Pick a price you can defend
   publicly.
3. Burn 100% of the LP tokens (`spl-token burn`). Publish the burn
   transaction.
4. Any QC not used for the pool goes back into a fresh hybrid vault the
   same day.

## 5. Fair launch policy

- No presale, no private sale, no discounted allocation to anyone.
- Nobody, the founder included, buys before the pool is public.
- The pool opens at an announced time with the pool address published in
  advance.
- Team tokens stay in the founder vault: locked until **2027-09-24**, then
  released monthly over 24 months. Every release is announced before the
  spend.

## 7. Airdrop policy

- 3–4 waves from the airdrop vault (3.3T QC total).
- Eligibility based on real use: devnet vault creators in Quantum Safe, bug
  reporters, contributors, early liquidity providers.
- Sybil filtering: one claim per wallet with history older than the
  snapshot; exclude clusters funded from the same source.
- Mechanics: one hybrid spend moves a wave's total into a distributor
  wallet, which pays recipients in batched Token-2022 transfers. Any
  leftover returns to a fresh vault. The recipient list is published.

## 8. Bug bounty

The bounty vault holds real QC, protected exactly like every other vault.
**Anyone who drains it without both keys keeps the QC.** Please report how
through a GitHub security advisory on `bryankwandou/QUANTCOIN`. Valid
reports of other vulnerabilities are paid from the reserve according to
severity. On mainnet, the same bounty vault is created with a larger
amount.

## 9. Founder identity

Anonymous founders are rated as higher risk. Options, from weakest to
strongest:

1. Share identity privately with the auditor.
2. A public name and GitHub history (already public: `bryankwandou`).
3. A public video or AMA.

This is the founder's decision. Option 2 is already true today.

## 10. Communication rules

Always say:

- "QC in a hybrid vault is quantum-resistant. QC in a normal wallet is as
  safe as any Solana token."
- "QC is a token on Solana." Never "Layer 2" or "a new blockchain".

Never say:

- Price predictions, "guaranteed" returns, "the next BTC/SOL".
- "Audited" before an external audit report is published.
- Anything from the old repo (fake mainnet, 1 trillion TPS, certificates).

Every claim links to something that can be checked on-chain or in this
repo.
