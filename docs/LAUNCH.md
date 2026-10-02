# QuantCoin launch plan

The ten trust commitments, what each one needs, and its status. Mainnet launched on 2026-09-29 before item 1 was done.

| # | Commitment | Status |
|---|---|---|
| 1 | External audit, report published | Scope ready (below); auditor not yet hired |
| 2 | Program `--final`, every authority revoked | Mint authorities revoked on mainnet; program upgradeable via Squads 2-of-3 until the audit |
| 3 | Pool liquidity permanently locked | Meteora DAMM v2, runbook below |
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

## 3. Liquidity and locked pool

Changed on 2026-10-02 from Raydium CPMM with burned LP tokens to a
single-sided Meteora DAMM v2 pool with a permanently locked position.
Raydium's 0.15 SOL creation fee did not fit the launch budget, and a
single-sided pool needs no SOL from the project. A locked position, like
burned LP tokens, can never be withdrawn by anyone.

1. Spend 22,000,000,000 QC (0.1% of supply) from the liquidity vault to the
   deployer wallet `GKPFmq8mKvgKrHRQX5nJToZhR2AsvzgcQsgCWv9aNnoN` (one
   hybrid spend). The rest (4.378T QC) moves into a fresh liquidity vault in
   the same spend.
2. Create the customizable pool QC/SOL on Meteora DAMM v2 with the 22B QC
   only (`client/launch-pool.ts`):
   - Opening price: 500 SOL for the whole 22T supply (0.0000000000227 SOL
     per QC). The founder chose this number; it is not a valuation.
   - The price range starts at the opening price, so the price can never
     trade below it: sellers can only take back SOL that buyers put in.
   - Anti-sniper fee: 50% when trading opens, falling to 0.25% over the
     first hour. A dynamic fee adds more when the price swings.
   - Fees are collected in SOL. Meteora keeps 20% of them. The rest is
     claimable by the position holder (the deployer wallet) and is moved,
     publicly, to the Squads multisig vault `45nAvRrgqxkdnsDmW9dmukHNcxE1TM5PnJsH27cTXxez`. The founder does not
     keep trading fees.
   - Liquidity is locked in the same transaction.
3. The pool address is fixed by the two mints and was published in advance:
   `AyS1vByiVFsVdsekRZE1mGVY5MHY1YMs59DeGwDwbbwB`. Trading opens at **2026-10-02 15:30 UTC (22:30 WIB)**.
4. The pool is small. A 0.01 SOL buy moves the price about 4%. It opens
   before the external audit (item 1).

Tested on a local mainnet fork before launch: buying before the opening
time is refused, the first buy pays about 50% fee, after one hour a 0.01
SOL buy moves the price 3.99%, and after every buyer sells, the price
returns exactly to the opening price.

## 5. Fair launch policy

- No presale, no private sale, no discounted allocation to anyone.
- Nobody, the founder included, buys before the pool is public.
- The pool opens at an announced time with the pool address published in
  advance.
- Team tokens: 20% (mainnet, 2026-09-29). The earlier commitment (10%,
  locked until 2027-09-24) was replaced at genesis and broken on
  2026-10-02, when founder vault 1 (5%) was spent to the founder's wallet
  without prior announcement. That 5% stays in the founder wallet,
  unlocked. Founder vaults 2–4 (15%) stay locked until **2027-09-24**;
  any later release is announced before the spend. See WHITEPAPER.md §4,
  "Changes to this section".

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
