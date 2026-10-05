//! Extended adversarial tests for the qc-vault Spend instruction after the
//! canonical-bump fix (commit 883c0ec). They run the deployed binary
//! (`target/deploy/qc_vault.so`) inside LiteSVM, so build it first:
//!
//!     cargo build-sbf --manifest-path programs/qc-vault/Cargo.toml
//!     cargo test -p qc-vault --test extended -- --nocapture
//!
//! Everything (WOTS keys, owners, program ids, accounts, mutations) comes from
//! a seeded xorshift PRNG, so a run is reproducible. Knobs:
//!   QC_FUZZ_SEED   PRNG seed
//!   QC_FUZZ_CASES  byte-flip fuzz cases (default 2200, at least 11 per vault)
//!   QC_BUMP_PAIRS  (pk_hash, owner) pairs swept over all 256 bumps (default 16)
//!   QC_BUMP_BYTE_PAIRS  pairs that also get the 255 wrong-bump-byte sweep (default 2)
//!   QC_GRIND       program ids tried when grinding low canonical bumps (default 16384)
//!   QC_PERMS       random account permutations (default 400)
//!   QC_FORGE_TRIES digests tried per forgery attempt in the key-reuse test (default 400000)
//!
//! VaultError codes: 1 BadInstruction, 2 BadSignature, 3 InsufficientBalance,
//! 4 NotATokenAccount, 5 BadTokenProgram, 6 DuplicateAccount,
//! 7 MissingOwnerSignature, 8 AlreadySpent.
use std::collections::BTreeMap;

use litesvm::LiteSVM;
use qc_vault::{spend_digest, wots, VAULT_SEED};
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

const T22: Address = Address::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const LEGACY: Address = Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA: Address = Address::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const CB: Address = Address::from_str_const("ComputeBudget111111111111111111111111111111");
const SYS: Address = Address::new_from_array([0; 32]);
const DECIMALS: u8 = 5;
const SO: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/qc_vault.so");

// =====================================================================
// Deterministic PRNG and knobs
// =====================================================================
struct Rng(u64);
impl Rng {
    fn from_env(salt: u64) -> Self {
        let s = std::env::var("QC_FUZZ_SEED").ok().and_then(|v| v.parse().ok()).unwrap_or(0x9E37_79B9_7F4A_7C15u64);
        println!("[seed] QC_FUZZ_SEED={s} salt={salt}");
        Rng((s ^ salt.wrapping_mul(0x2545_F491_4F6C_DD1D)) | 1)
    }
    fn u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn below(&mut self, n: u64) -> u64 { self.u64() % n }
    fn fill(&mut self, b: &mut [u8]) { for x in b { *x = self.u64() as u8; } }
    fn arr<const L: usize>(&mut self) -> [u8; L] { let mut a = [0u8; L]; self.fill(&mut a); a }
    fn kp(&mut self) -> Keypair { Keypair::new_from_array(self.arr()) }
}
fn knob(name: &str, default: usize) -> usize {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

// =====================================================================
// LiteSVM harness (based on tests/fuzz.rs; deterministic addresses)
// =====================================================================
struct Env { svm: LiteSVM, prog: Address, payer: Keypair, mint: Address, tag: [u8; 8], ctr: u64 }
/// A WOTS one-time key: master secret, public seed and the 32-byte commitment.
struct Key { master: [u8; 32], seed: [u8; 16], pk: [u8; 32] }
/// A vault address for (key, owner, bump) under program `prog`; `ta` is its
/// Token-2022 associated token account for the env mint (may not exist yet).
struct Vault { master: [u8; 32], seed: [u8; 16], owner: Keypair, pda: Address, bump: u8, ta: Address, prog: Address }

impl Key {
    fn new(rng: &mut Rng) -> Key {
        let master: [u8; 32] = rng.arr();
        let seed: [u8; 16] = rng.arr();
        Key { master, seed, pk: wots::keys::public_key_hash(&master, &seed) }
    }
}

/// Failed transaction: debug error, CU consumed, program logs.
struct Fail { err: String, cu: u64, logs: String }
impl std::fmt::Debug for Fail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} CU={}\n{}", self.err, self.cu, self.logs)
    }
}
type Out = Result<u64, Fail>;

fn send(svm: &mut LiteSVM, payer: &Keypair, extra: &[&Keypair], ixs: &[Instruction]) -> Out {
    let mut signers: Vec<&Keypair> = vec![payer];
    for k in extra { if !signers.iter().any(|s| s.pubkey() == k.pubkey()) { signers.push(k); } }
    let tx = Transaction::new(&signers, Message::new(ixs, Some(&payer.pubkey())), svm.latest_blockhash());
    svm.send_transaction(tx)
        .map(|m| m.compute_units_consumed)
        .map_err(|e| Fail { err: format!("{:?}", e.err), cu: e.meta.compute_units_consumed, logs: e.meta.logs.join("\n") })
}
/// Sends and then expires the blockhash, so no two transactions can collide
/// in the status cache (AlreadyProcessed would mask the real result).
impl Env {
    fn exec(&mut self, extra: &[&Keypair], ixs: &[Instruction]) -> Out {
        let r = send(&mut self.svm, &self.payer, extra, ixs);
        self.svm.expire_blockhash();
        r
    }
}
/// Custom program error code in a failed transaction, if any.
fn code(f: &Fail) -> Option<u32> {
    let i = f.err.find("Custom(")? + 7;
    f.err[i..].split(')').next()?.parse().ok()
}
#[track_caller]
fn expect_code(r: Out, want: u32, ctx: &str) -> u64 {
    match r {
        Ok(cu) => panic!("{ctx}: succeeded ({cu} CU), expected Custom({want})"),
        Err(f) => {
            assert_eq!(code(&f), Some(want), "{ctx}: wrong error {f:?}");
            assert!(!t22_failed(&f), "{ctx}: Custom({want}) came from Token-2022, not qc-vault: {f:?}");
            f.cu
        }
    }
}
/// True when the failure happened inside a Token-2022 CPI (its custom codes
/// overlap qc-vault's, e.g. Token-2022 MintMismatch is also Custom(3)).
fn t22_failed(f: &Fail) -> bool {
    f.logs.contains("Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb failed")
}
fn short(f: &Fail) -> String {
    let base = match code(f) { Some(c) => format!("Custom({c})"), None => f.err.clone() };
    if t22_failed(f) { format!("Token-2022 CPI failed: {base}") } else { base }
}
/// A failure that is not a qc-vault error code: inside a Token-2022 CPI or a
/// runtime check (privilege escalation, read-only lamport change).
fn not_vault_error(f: &Fail) -> bool { code(f).is_none() || t22_failed(f) }
/// Keypairs among `keys` that some meta marks as signer.
fn signers_for<'a>(metas: &[AccountMeta], keys: &[&'a Keypair]) -> Vec<&'a Keypair> {
    let mut out: Vec<&Keypair> = vec![];
    for k in keys {
        let pk = k.pubkey();
        if metas.iter().any(|m| m.is_signer && m.pubkey == pk) && !out.iter().any(|o| o.pubkey() == pk) { out.push(k); }
    }
    out
}

fn fresh_bytes(env: &mut Env) -> [u8; 32] {
    env.ctr += 1;
    wots::hashv(&[b"qc-ext/fresh", &env.tag, &env.ctr.to_le_bytes()])
}
fn fresh_kp(env: &mut Env) -> Keypair { let b = fresh_bytes(env); Keypair::new_from_array(b) }
fn fresh_addr(env: &mut Env) -> Address { Address::new_from_array(fresh_bytes(env)) }

fn create(env: &mut Env, kp: &Keypair, space: u64, owner: &Address) {
    let lamports = env.svm.minimum_balance_for_rent_exemption(space as usize);
    let ix = solana_system_interface::instruction::create_account(&env.payer.pubkey(), &kp.pubkey(), lamports, space, owner);
    env.exec(&[kp], &[ix]).unwrap();
}
fn new_mint_with(env: &mut Env, space: u64, pre: Vec<u8>) -> Address {
    let kp = fresh_kp(env);
    create(env, &kp, space, &T22);
    let mut ixs = vec![];
    if !pre.is_empty() {
        ixs.push(Instruction::new_with_bytes(T22, &pre, vec![AccountMeta::new(kp.pubkey(), false)]));
    }
    let mut d = vec![20u8, DECIMALS]; // InitializeMint2
    d.extend_from_slice(env.payer.pubkey().as_ref());
    d.push(0);
    ixs.push(Instruction::new_with_bytes(T22, &d, vec![AccountMeta::new(kp.pubkey(), false)]));
    env.exec(&[], &ixs).unwrap();
    kp.pubkey()
}
/// Token-2022 account for `mint` owned by `owner` at a fresh address.
fn token_account_for(env: &mut Env, mint: Address, owner: &Address) -> Address {
    let kp = fresh_kp(env);
    create(env, &kp, 165, &T22);
    let mut d = vec![18u8]; // InitializeAccount3
    d.extend_from_slice(owner.as_ref());
    let ix = Instruction::new_with_bytes(T22, &d, vec![AccountMeta::new(kp.pubkey(), false), AccountMeta::new_readonly(mint, false)]);
    env.exec(&[], &[ix]).unwrap();
    kp.pubkey()
}
fn token_account(env: &mut Env) -> Address {
    let (mint, owner) = (env.mint, fresh_addr(env));
    token_account_for(env, mint, &owner)
}
fn ata_addr(owner: &Address, mint: &Address) -> Address {
    Address::find_program_address(&[owner.as_ref(), T22.as_ref(), mint.as_ref()], &ATA).0
}
/// Creates `owner`'s Token-2022 ATA for `mint` through the ATA program.
fn create_ata(env: &mut Env, owner: &Address, mint: Address) -> Address {
    let a = ata_addr(owner, &mint);
    let ix = Instruction::new_with_bytes(ATA, &[1], vec![ // CreateIdempotent
        AccountMeta::new(env.payer.pubkey(), true), AccountMeta::new(a, false),
        AccountMeta::new_readonly(*owner, false), AccountMeta::new_readonly(mint, false),
        AccountMeta::new_readonly(SYS, false), AccountMeta::new_readonly(T22, false)]);
    env.exec(&[], &[ix]).unwrap();
    a
}
fn mint_to_of(env: &mut Env, mint: Address, ta: Address, amount: u64) {
    let mut d = vec![14u8]; // MintToChecked
    d.extend_from_slice(&amount.to_le_bytes());
    d.push(DECIMALS);
    let ix = Instruction::new_with_bytes(T22, &d, vec![
        AccountMeta::new(mint, false), AccountMeta::new(ta, false), AccountMeta::new_readonly(env.payer.pubkey(), true)]);
    env.exec(&[], &[ix]).unwrap();
}
fn mint_to(env: &mut Env, ta: Address, amount: u64) { let m = env.mint; mint_to_of(env, m, ta, amount) }
fn balance(env: &Env, ta: &Address) -> Option<u64> {
    env.svm.get_account(ta).filter(|a| a.lamports > 0 && a.data.len() >= 72).map(|a| u64::from_le_bytes(a.data[64..72].try_into().unwrap()))
}
fn lamports(env: &Env, a: &Address) -> u64 { env.svm.get_account(a).map_or(0, |x| x.lamports) }
fn setup(rng: &mut Rng) -> Env {
    let mut svm = LiteSVM::new();
    let prog = Address::new_from_array(rng.arr());
    svm.add_program_from_file(prog, SO).unwrap();
    let payer = rng.kp();
    svm.airdrop(&payer.pubkey(), 10_000_000_000_000).unwrap();
    let mut env = Env { svm, prog, payer, mint: SYS, tag: rng.arr(), ctr: 0 };
    env.mint = new_mint_with(&mut env, 82, vec![]);
    env
}
/// Vault at an explicit bump (None if that bump is on-curve).
fn vault_at(env: &Env, prog: Address, key: &Key, owner: &Keypair, bump: u8) -> Option<Vault> {
    let pda = Address::create_program_address(&[VAULT_SEED, &key.pk, owner.pubkey().as_ref(), &[bump]], &prog).ok()?;
    Some(Vault { master: key.master, seed: key.seed, owner: owner.insecure_clone(), pda, bump, ta: ata_addr(&pda, &env.mint), prog })
}
/// The canonical vault (find_program_address bump).
fn canonical(env: &Env, prog: Address, key: &Key, owner: &Keypair) -> Vault {
    let (_, b) = Address::find_program_address(&[VAULT_SEED, &key.pk, owner.pubkey().as_ref()], &prog);
    vault_at(env, prog, key, owner, b).unwrap()
}
/// Creates the vault's ATA and mints `amount` into it.
fn fund(env: &mut Env, v: &Vault, amount: u64) {
    let m = env.mint;
    assert_eq!(create_ata(env, &v.pda, m), v.ta);
    if amount > 0 { mint_to(env, v.ta, amount); }
}
fn new_vault(env: &mut Env, rng: &mut Rng, amount: u64) -> Vault {
    let key = Key::new(rng);
    let owner = rng.kp();
    let p = env.prog;
    let v = canonical(env, p, &key, &owner);
    fund(env, &v, amount);
    v
}
fn digest_of(v: &Vault, mint: &Address, dest: &Address, refund: &Address, rent_to: &Address, amount: u64) -> [u8; 24] {
    spend_digest(v.prog.as_array(), v.pda.as_array(), mint.as_array(), dest.as_array(), refund.as_array(), rent_to.as_array(), amount)
}
fn data_from_sig(bump: u8, seed: &[u8; 16], amount: u64, sig: &[u8]) -> Vec<u8> {
    let mut d = vec![0u8, bump];
    d.extend_from_slice(seed);
    d.extend_from_slice(&amount.to_le_bytes());
    d.extend_from_slice(sig);
    d
}
fn spend_data_mint(v: &Vault, mint: &Address, dest: Address, refund: Address, rent_to: Address, amount: u64) -> Vec<u8> {
    let sig = wots::keys::sign(&v.master, &v.seed, &digest_of(v, mint, &dest, &refund, &rent_to, amount));
    data_from_sig(v.bump, &v.seed, amount, &sig)
}
fn spend_data(env: &Env, v: &Vault, dest: Address, refund: Address, rent_to: Address, amount: u64) -> Vec<u8> {
    spend_data_mint(v, &env.mint, dest, refund, rent_to, amount)
}
fn metas(env: &Env, v: &Vault, dest: Address, refund: Address, rent_to: Address) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new(v.pda, false),
        AccountMeta::new(v.ta, false),
        AccountMeta::new_readonly(env.mint, false),
        AccountMeta::new(dest, false),
        AccountMeta::new(refund, false),
        AccountMeta::new(rent_to, false),
        AccountMeta::new_readonly(T22, false),
        AccountMeta::new_readonly(v.owner.pubkey(), true),
        AccountMeta::new_readonly(SYS, false),
    ]
}
fn ix_of(v: &Vault, accounts: Vec<AccountMeta>, data: Vec<u8>) -> Instruction {
    Instruction { program_id: v.prog, accounts, data }
}
fn spend_ix(env: &Env, v: &Vault, dest: Address, refund: Address, rent_to: Address, amount: u64) -> Instruction {
    ix_of(v, metas(env, v, dest, refund, rent_to), spend_data(env, v, dest, refund, rent_to, amount))
}
fn cu_limit() -> Instruction {
    let mut d = vec![2u8];
    d.extend_from_slice(&1_400_000u32.to_le_bytes());
    Instruction::new_with_bytes(CB, &d, vec![])
}
fn is_spent(env: &Env, v: &Vault) -> bool { env.svm.get_account(&v.pda).is_some_and(|a| a.owner == v.prog) }
#[track_caller]
fn assert_untouched(env: &Env, v: &Vault, bal: u64, ctx: &str) {
    assert_eq!(balance(env, &v.ta), Some(bal), "{ctx}: vault balance changed");
    assert!(!is_spent(env, v), "{ctx}: vault marked spent");
}
#[track_caller]
fn assert_spent_and_closed(env: &Env, v: &Vault, ctx: &str) {
    assert!(is_spent(env, v), "{ctx}: vault not marked spent");
    assert_eq!(balance(env, &v.ta), None, "{ctx}: vault token account not closed");
    let m = env.svm.get_account(&v.pda).unwrap();
    assert!(m.data.is_empty(), "{ctx}: marker has data");
    assert_eq!(m.lamports, env.svm.minimum_balance_for_rent_exemption(0), "{ctx}: marker lamports");
}
/// Bumps 0..=255 that give an off-curve vault address, ascending.
fn valid_bumps(prog: &Address, pk: &[u8; 32], owner: &Address) -> Vec<(u8, Address)> {
    (0..=255u8)
        .filter_map(|b| Address::create_program_address(&[VAULT_SEED, pk, owner.as_ref(), &[b]], prog).ok().map(|a| (b, a)))
        .collect()
}
/// Least squares fit y = X beta (X rows already contain the intercept 1.0).
fn lstsq(x: &[Vec<f64>], y: &[f64]) -> Option<Vec<f64>> {
    let k = x[0].len();
    let mut a = vec![vec![0f64; k + 1]; k];
    for (row, yi) in x.iter().zip(y) {
        for i in 0..k {
            for j in 0..k { a[i][j] += row[i] * row[j]; }
            a[i][k] += row[i] * yi;
        }
    }
    for c in 0..k {
        let p = (c..k).max_by(|&i, &j| a[i][c].abs().partial_cmp(&a[j][c].abs()).unwrap())?;
        if a[p][c].abs() < 1e-9 { return None; }
        a.swap(c, p);
        for r in 0..k {
            if r != c {
                let f = a[r][c] / a[c][c];
                for j in c..=k { a[r][j] -= f * a[c][j]; }
            }
        }
    }
    Some((0..k).map(|i| a[i][k] / a[i][i]).collect())
}

// =====================================================================
// 1. Canonical bump: every valid non-canonical bump is refused
// =====================================================================

/// For QC_BUMP_PAIRS random (pk_hash, owner) pairs: every off-curve bump below
/// the canonical one is turned into its own vault, its ATA is created and
/// funded (so before the fix the spend would have succeeded), and a correctly
/// signed spend from it must fail with BadSignature (2). The PDA match passes
/// for these by construction (the signature is valid for that address), so the
/// rejection can only come from the canonical-bump loop. For the first
/// QC_BUMP_BYTE_PAIRS pairs the canonical vault's valid spend is also replayed
/// with each of the other 255 bump bytes (2 every time). The canonical spend
/// then succeeds, and the non-canonical vaults stay refused afterwards.
#[test]
fn bump_every_valid_noncanonical_rejected_canonical_accepted() {
    let mut rng = Rng::from_env(101);
    let mut env = setup(&mut rng);
    let pairs = knob("QC_BUMP_PAIRS", 16);
    let byte_pairs = knob("QC_BUMP_BYTE_PAIRS", 2);
    let dest = token_account(&mut env);
    let refund = token_account(&mut env);
    let rent_to = fresh_addr(&mut env);
    let (mut alt_rejected, mut byte_rejected, mut accepted, mut after_rejected) = (0usize, 0usize, 0usize, 0usize);
    let mut canon_hist: BTreeMap<u8, usize> = BTreeMap::new();
    let mut total_valid = 0usize;
    let t0 = std::time::Instant::now();
    for p in 0..pairs {
        let key = Key::new(&mut rng);
        let owner = rng.kp();
        let valid = valid_bumps(&env.prog, &key.pk, &owner.pubkey());
        let (find_pda, find_bump) = Address::find_program_address(&[VAULT_SEED, &key.pk, owner.pubkey().as_ref()], &env.prog);
        let (cb, ca) = *valid.last().expect("some bump is off-curve");
        assert_eq!((cb, ca), (find_bump, find_pda), "pair {p}: highest off-curve bump must be the canonical one");
        total_valid += valid.len();
        *canon_hist.entry(cb).or_default() += 1;
        let v = vault_at(&env, env.prog, &key, &owner, cb).unwrap();
        fund(&mut env, &v, 1_000);
        let good = spend_data(&env, &v, dest, refund, rent_to, 1_000);

        // (a) the canonical vault's valid spend with every other bump byte
        if p < byte_pairs {
            for b in (0..=255u8).filter(|b| *b != cb) {
                let mut d = good.clone();
                d[1] = b;
                let ix = ix_of(&v, metas(&env, &v, dest, refund, rent_to), d);
                expect_code(env.exec(&[&v.owner], &[cu_limit(), ix]), 2, &format!("pair {p} bump byte {b} (canonical {cb})"));
                byte_rejected += 1;
            }
            assert_untouched(&env, &v, 1_000, "after bump-byte sweep");
        }

        // (b) every valid non-canonical bump as its own funded vault
        let mut alts = vec![];
        for &(b, a) in &valid[..valid.len() - 1] {
            let alt = vault_at(&env, env.prog, &key, &owner, b).unwrap();
            assert_eq!(alt.pda, a);
            assert_ne!(alt.pda, v.pda);
            fund(&mut env, &alt, 777);
            let ix = spend_ix(&env, &alt, dest, refund, rent_to, 777);
            expect_code(env.exec(&[&alt.owner], &[cu_limit(), ix]), 2, &format!("pair {p} non-canonical bump {b} (canonical {cb})"));
            assert_untouched(&env, &alt, 777, &format!("pair {p} bump {b}"));
            alt_rejected += 1;
            alts.push(alt);
        }

        // (c) the canonical bump is accepted
        let ix = ix_of(&v, metas(&env, &v, dest, refund, rent_to), good);
        env.exec(&[&v.owner], &[cu_limit(), ix]).unwrap_or_else(|e| panic!("pair {p}: canonical spend failed {e:?}"));
        assert_spent_and_closed(&env, &v, &format!("pair {p} canonical"));
        accepted += 1;

        // (d) spending the canonical vault does not unlock any sibling
        for alt in alts.iter().take(3) {
            let ix = spend_ix(&env, alt, dest, refund, rent_to, 777);
            expect_code(env.exec(&[&alt.owner], &[cu_limit(), ix]), 2, "sibling after canonical spend");
            assert_untouched(&env, alt, 777, "sibling after canonical spend");
            after_rejected += 1;
        }
    }
    assert_eq!(balance(&env, &dest), Some(1_000 * pairs as u64));
    println!("[bump-sweep] pairs={pairs} valid bumps total={total_valid} (avg {:.1}/pair) canonical histogram={canon_hist:?}",
        total_valid as f64 / pairs as f64);
    println!("[bump-sweep] non-canonical funded vaults rejected (Custom(2)): {alt_rejected}");
    println!("[bump-sweep] wrong bump bytes on canonical vault rejected (Custom(2)): {byte_rejected}");
    println!("[bump-sweep] canonical spends accepted: {accepted}; siblings re-checked after spend: {after_rejected}; {:.1}s",
        t0.elapsed().as_secs_f64());
}

/// Bump edge cases: canonical 255 (the loop runs zero times), canonical 254
/// (one iteration, checks 255), bump byte 255 when 255 is on-curve, bump 0 when
/// 0 is off-curve (non-canonical, funded: refused) and when 0 is on-curve.
#[test]
fn bump_edge_cases_0_and_255() {
    let mut rng = Rng::from_env(102);
    let mut env = setup(&mut rng);
    let key = Key::new(&mut rng);
    let dest = token_account(&mut env);
    let refund = token_account(&mut env);
    let rent_to = fresh_addr(&mut env);
    // Grind seeded owners for the shapes we need.
    let (mut o255, mut o254, mut zero_valid, mut zero_invalid) = (None, None, None, None);
    for _ in 0..4096 {
        let o = rng.kp();
        let (_, c) = Address::find_program_address(&[VAULT_SEED, &key.pk, o.pubkey().as_ref()], &env.prog);
        let z = Address::create_program_address(&[VAULT_SEED, &key.pk, o.pubkey().as_ref(), &[0]], &env.prog).is_ok();
        // One role per owner: each role spends its own vault.
        if c == 255 && o255.is_none() { o255 = Some(o); }
        else if c == 254 && o254.is_none() { o254 = Some(o); }
        else if z && zero_valid.is_none() { zero_valid = Some(o); }
        else if !z && zero_invalid.is_none() { zero_invalid = Some(o); }
        if o255.is_some() && o254.is_some() && zero_valid.is_some() && zero_invalid.is_some() { break; }
    }
    let (o255, o254, zv, zi) = (o255.unwrap(), o254.unwrap(), zero_valid.unwrap(), zero_invalid.unwrap());

    // Canonical 255: accepted, and any lower valid bump (e.g. the next one) refused.
    let v255 = canonical(&env, env.prog, &key, &o255);
    assert_eq!(v255.bump, 255);
    fund(&mut env, &v255, 1_000);
    let lower = valid_bumps(&env.prog, &key.pk, &o255.pubkey());
    let (lb, _) = lower[lower.len() - 2];
    let alt = vault_at(&env, env.prog, &key, &o255, lb).unwrap();
    fund(&mut env, &alt, 500);
    expect_code(env.exec(&[&o255], &[cu_limit(), spend_ix(&env, &alt, dest, refund, rent_to, 500)]), 2, "bump below canonical 255");
    let cu255 = env.exec(&[&o255], &[cu_limit(), spend_ix(&env, &v255, dest, refund, rent_to, 1_000)]).expect("canonical 255");
    assert_spent_and_closed(&env, &v255, "canonical 255");
    println!("[bump-edge] canonical 255 accepted ({cu255} CU, 0 loop iterations); bump {lb} refused");

    // Canonical 254: bump byte 255 (on-curve) refused, 254 accepted.
    let v254 = canonical(&env, env.prog, &key, &o254);
    assert_eq!(v254.bump, 254);
    assert!(Address::create_program_address(&[VAULT_SEED, &key.pk, o254.pubkey().as_ref(), &[255]], &env.prog).is_err());
    fund(&mut env, &v254, 1_000);
    let good = spend_data(&env, &v254, dest, refund, rent_to, 1_000);
    let mut d = good.clone();
    d[1] = 255;
    expect_code(env.exec(&[&o254], &[cu_limit(), ix_of(&v254, metas(&env, &v254, dest, refund, rent_to), d)]), 2, "bump byte 255 on-curve");
    let cu254 = env.exec(&[&o254], &[cu_limit(), ix_of(&v254, metas(&env, &v254, dest, refund, rent_to), good)]).expect("canonical 254");
    assert_spent_and_closed(&env, &v254, "canonical 254");
    println!("[bump-edge] canonical 254 accepted ({cu254} CU, 1 loop iteration); bump byte 255 refused");

    // Bump 0 off-curve (a real, non-canonical vault): funded, refused.
    let v0 = vault_at(&env, env.prog, &key, &zv, 0).expect("bump 0 off-curve");
    let vc = canonical(&env, env.prog, &key, &zv);
    assert!(vc.bump > 0);
    fund(&mut env, &v0, 900);
    let cu0 = expect_code(env.exec(&[&zv], &[cu_limit(), spend_ix(&env, &v0, dest, refund, rent_to, 900)]), 2, "bump 0 off-curve");
    assert_untouched(&env, &v0, 900, "bump 0");
    let next = valid_bumps(&env.prog, &key.pk, &zv.pubkey())[1].0;
    println!("[bump-edge] bump 0 (off-curve, canonical {}) refused ({cu0} CU, loop stops at bump {next})", vc.bump);

    // Bump 0 on-curve: no vault exists there; the canonical vault's spend with byte 0 is refused.
    let vz = canonical(&env, env.prog, &key, &zi);
    fund(&mut env, &vz, 900);
    let good = spend_data(&env, &vz, dest, refund, rent_to, 900);
    let mut d = good.clone();
    d[1] = 0;
    expect_code(env.exec(&[&zi], &[cu_limit(), ix_of(&vz, metas(&env, &vz, dest, refund, rent_to), d)]), 2, "bump byte 0 on-curve");
    env.exec(&[&zi], &[cu_limit(), ix_of(&vz, metas(&env, &vz, dest, refund, rent_to), good)]).expect("canonical after bump-0 attempt");
    assert_spent_and_closed(&env, &vz, "canonical after bump-0");
    println!("[bump-edge] bump byte 0 (on-curve) refused; canonical {} accepted", vz.bump);
}

// =====================================================================
// 2. Compute cost of the canonical-bump check
// =====================================================================

/// Accept path: program ids are ground so that one (key, owner) gets every
/// canonical bump from 255 down to the lowest found. For each, CU(valid spend)
/// minus CU(same data, owner swapped for another signer -> refused right at the
/// PDA match) isolates everything after the match; regressing it on
/// (255 - canonical) gives the per-iteration cost of the check. ATA lookups
/// (sol_try_find_program_address, 1,500 CU per extra bump tried) are removed
/// with the runtime's own cost model and the fit residual confirms it.
/// Reject path: every non-canonical bump of two vaults, CU(refused spend) minus
/// CU(owner-swapped baseline) against k = distance to the next off-curve bump.
#[test]
fn cu_canonical_check_accept_and_reject() {
    let mut rng = Rng::from_env(103);
    let mut env = setup(&mut rng);
    let key = Key::new(&mut rng);
    let owner = rng.kp();
    let stranger = rng.kp();
    let dest = token_account(&mut env);
    let refund = token_account(&mut env);
    let rent_to = fresh_addr(&mut env);
    let grind = knob("QC_GRIND", 16_384);
    let mut by_c: BTreeMap<u8, Address> = BTreeMap::new();
    by_c.insert(Address::find_program_address(&[VAULT_SEED, &key.pk, owner.pubkey().as_ref()], &env.prog).1, env.prog);
    let t0 = std::time::Instant::now();
    for _ in 0..grind {
        let prog = Address::new_from_array(rng.arr());
        let (_, c) = Address::find_program_address(&[VAULT_SEED, &key.pk, owner.pubkey().as_ref()], &prog);
        by_c.entry(c).or_insert(prog);
    }
    println!("[cu] ground {grind} program ids in {:.1}s: canonical bumps found {:?}", t0.elapsed().as_secs_f64(), by_c.keys().collect::<Vec<_>>());
    assert!(by_c.contains_key(&255) && by_c.keys().any(|c| *c <= 248), "grind found too few canonical bumps");

    // Accept path.
    let mut rows = vec![];
    println!("[cu] accept path: canonical | iters | ata tries | CU(valid spend) | CU(baseline) | delta");
    for (&c, &prog) in by_c.iter().rev() {
        if prog != env.prog { env.svm.add_program_from_file(prog, SO).unwrap(); }
        let v = canonical(&env, prog, &key, &owner);
        assert_eq!(v.bump, c);
        fund(&mut env, &v, 10_000);
        let data = spend_data(&env, &v, dest, refund, rent_to, 4_000);
        let mut acc = metas(&env, &v, dest, refund, rent_to);
        acc[7].pubkey = stranger.pubkey();
        let base = expect_code(env.exec(&[&stranger], &[cu_limit(), ix_of(&v, acc, data.clone())]), 2, "owner-swapped baseline");
        let cu = env.exec(&[&owner], &[cu_limit(), ix_of(&v, metas(&env, &v, dest, refund, rent_to), data)]).expect("canonical spend");
        assert_spent_and_closed(&env, &v, "cu accept");
        let ata_tries = 256 - Address::find_program_address(&[v.pda.as_ref(), T22.as_ref(), env.mint.as_ref()], &ATA).1 as u64;
        let iters = 255 - c as u64;
        println!("[cu]   {c:>3} | {iters:>2} | {ata_tries} | {cu:>7} | {base:>7} | {:>6}", cu - base);
        rows.push((iters as f64, ata_tries as f64, (cu - base) as f64, cu));
    }
    let x: Vec<Vec<f64>> = rows.iter().map(|r| vec![1.0, r.0]).collect();
    let y: Vec<f64> = rows.iter().map(|r| r.2 - 1500.0 * (r.1 - 1.0)).collect();
    let fit = lstsq(&x, &y).expect("accept fit");
    let res = rows.iter().zip(&y).map(|(r, yi)| (yi - fit[0] - fit[1] * r.0).abs()).fold(0f64, f64::max);
    println!("[cu] accept path fit: post-match cost {:.1} + {:.2} CU x (255 - canonical); max residual {res:.2} CU", fit[0], fit[1]);
    let min_cu = rows.iter().map(|r| r.3).min().unwrap();
    let max_cu = rows.iter().map(|r| r.3).max().unwrap();
    println!("[cu] accept path: valid spends ranged {min_cu}..{max_cu} CU (WOTS work varies with the digest)");

    // Reject path.
    let mut pts = vec![];
    for (i, (&c, &prog)) in by_c.iter().rev().enumerate().filter(|(i, _)| *i < 2) {
        let o2 = rng.kp();
        let _ = (i, c);
        let valid = valid_bumps(&prog, &key.pk, &o2.pubkey());
        for w in valid.windows(2) {
            let (b, nb) = (w[0].0, w[1].0);
            let alt = vault_at(&env, prog, &key, &o2, b).unwrap();
            let data = spend_data(&env, &alt, dest, refund, rent_to, 1);
            let mut acc = metas(&env, &alt, dest, refund, rent_to);
            acc[7].pubkey = stranger.pubkey();
            let base = expect_code(env.exec(&[&stranger], &[cu_limit(), ix_of(&alt, acc, data.clone())]), 2, "reject baseline");
            let r = expect_code(env.exec(&[&o2], &[cu_limit(), ix_of(&alt, metas(&env, &alt, dest, refund, rent_to), data)]), 2, "non-canonical");
            pts.push(((nb - b) as f64, r as f64 - base as f64));
        }
    }
    let x: Vec<Vec<f64>> = pts.iter().map(|p| vec![1.0, p.0]).collect();
    let y: Vec<f64> = pts.iter().map(|p| p.1).collect();
    let rfit = lstsq(&x, &y).expect("reject fit");
    let rres = pts.iter().map(|p| (p.1 - rfit[0] - rfit[1] * p.0).abs()).fold(0f64, f64::max);
    let kmax = pts.iter().map(|p| p.0 as u64).max().unwrap();
    let dmax = pts.iter().map(|p| p.1 as i64).max().unwrap();
    println!("[cu] reject path: {} non-canonical bumps; extra CU vs PDA-mismatch baseline = {:.1} + {:.2} x k (k = steps to next off-curve bump, 1..={kmax}); max residual {rres:.2}; max extra {dmax} CU",
        pts.len(), rfit[0], rfit[1]);
    println!("[cu] summary: each loop iteration costs ~{:.0} CU (one sol_create_program_address = 1,500 CU + loop overhead).", rfit[1]);
    println!("[cu]   accept path: (255 - canonical) iterations; canonical 255 -> 0; expected ~1 iteration (~{:.0} CU) for a random vault; >10 iterations has probability 2^-10.", rfit[1]);
    println!("[cu]   reject path: iterations = distance to the next off-curve bump (mean ~2); the refusal comes after the WOTS work, so the attacker pays for it.");
    assert!(rfit[1] > 1500.0 && rfit[1] < 1700.0, "unexpected per-iteration cost {}", rfit[1]);
    assert!((fit[1] - rfit[1]).abs() < 50.0, "accept and reject per-iteration costs disagree: {} vs {}", fit[1], rfit[1]);
}

// =====================================================================
// 3. Seeded randomized fuzz: byte flips must fail, valid spends must succeed
// =====================================================================

/// QC_FUZZ_CASES (default 2200) cases in groups of 11 per fresh vault: ten
/// mutations of a valid spend (discriminator, bump, seed, amount, single and
/// multi-byte signature flips, flips anywhere, truncation, extension, WOTS
/// chain walked one step forward, two chains swapped), each asserting the exact
/// error code and that nothing moved, then the valid spend itself, asserting
/// exact balance deltas, the closed token account and the spent marker. After
/// the spend, the valid data and one mutation are replayed (AlreadySpent).
#[test]
fn fuzz_byte_flips_fail_valid_spends_succeed() {
    let mut rng = Rng::from_env(104);
    let mut env = setup(&mut rng);
    let n = knob("QC_FUZZ_CASES", 2_200).max(11);
    let vaults = n / 11;
    let dests: Vec<Address> = (0..3).map(|_| token_account(&mut env)).collect();
    let refunds: Vec<Address> = (0..3).map(|_| token_account(&mut env)).collect();
    let names = ["discriminator", "bump", "seed", "amount", "sig-1bit", "sig-multi", "anywhere", "truncate", "extend", "chain-walk", "chain-swap"];
    let mut per_kind = [0usize; 11];
    let (mut valid_ok, mut replays, mut moved_total) = (0usize, 0usize, 0u128);
    let t0 = std::time::Instant::now();
    for vi in 0..vaults {
        let fund_amt = match rng.below(10) { 0 => 1, 1 => u32::MAX as u64, _ => 1 + rng.below(1_000_000_000_000) };
        let v = new_vault(&mut env, &mut rng, fund_amt);
        let amount = match rng.below(8) { 0 => 0, 1 => fund_amt, _ => rng.below(fund_amt + 1) };
        let (dest, refund) = (dests[rng.below(3) as usize], refunds[rng.below(3) as usize]);
        let rent_to = fresh_addr(&mut env);
        let valid = spend_data(&env, &v, dest, refund, rent_to, amount);
        let digest = digest_of(&v, &env.mint, &dest, &refund, &rent_to, amount);
        let dg = wots::digits(&digest);
        for m in 0..10usize {
            let kind = (vi * 10 + m) % 11;
            let mut d = valid.clone();
            let want = match kind {
                0 => { d[0] = 1 + rng.below(255) as u8; 1 }
                1 => { d[1] ^= 1 + rng.below(255) as u8; 2 }
                2 => { for _ in 0..1 + rng.below(3) { d[2 + rng.below(16) as usize] ^= 1 + rng.below(255) as u8; } 2 }
                3 => { for _ in 0..1 + rng.below(3) { d[18 + rng.below(8) as usize] ^= 1 + rng.below(255) as u8; } 2 }
                4 => { d[26 + rng.below(624) as usize] ^= 1 << rng.below(8); 2 }
                5 => { for _ in 0..2 + rng.below(7) { d[26 + rng.below(624) as usize] ^= 1 + rng.below(255) as u8; } 2 }
                6 => { for _ in 0..1 + rng.below(4) { d[1 + rng.below(649) as usize] ^= 1 + rng.below(255) as u8; } 2 }
                7 => { d.truncate(rng.below(650) as usize); 1 }
                8 => { let extra = 1 + rng.below(400) as usize; for _ in 0..extra { d.push(rng.u64() as u8); } 1 }
                9 => {
                    // Walk one chain one step forward (what a single signature lets anyone do).
                    let mut i = rng.below(26) as usize;
                    while dg[i] == 255 { i = (i + 1) % 26; }
                    let at = 26 + i * 24;
                    let cur: [u8; 24] = d[at..at + 24].try_into().unwrap();
                    let next = wots::chain_step(&v.seed, i as u8, dg[i], &cur);
                    d[at..at + 24].copy_from_slice(&next);
                    2
                }
                _ => {
                    let i = rng.below(26) as usize;
                    let j = (i + 1 + rng.below(25) as usize) % 26;
                    let (a, b) = (26 + i * 24, 26 + j * 24);
                    let ci: Vec<u8> = d[a..a + 24].to_vec();
                    let cj: Vec<u8> = d[b..b + 24].to_vec();
                    d[a..a + 24].copy_from_slice(&cj);
                    d[b..b + 24].copy_from_slice(&ci);
                    2
                }
            };
            assert_ne!(d, valid, "mutation {kind} produced the valid data");
            let ix = ix_of(&v, metas(&env, &v, dest, refund, rent_to), d);
            expect_code(env.exec(&[&v.owner], &[cu_limit(), ix]), want, &format!("vault {vi} mutation {}", names[kind]));
            assert_untouched(&env, &v, fund_amt, names[kind]);
            per_kind[kind] += 1;
        }
        // The valid spend.
        let (d0, r0, l0) = (balance(&env, &dest).unwrap(), balance(&env, &refund).unwrap(), lamports(&env, &rent_to));
        let ix = ix_of(&v, metas(&env, &v, dest, refund, rent_to), valid.clone());
        env.exec(&[&v.owner], &[cu_limit(), ix]).unwrap_or_else(|e| panic!("vault {vi}: valid spend failed (fund {fund_amt}, amount {amount}): {e:?}"));
        assert_eq!(balance(&env, &dest).unwrap() - d0, amount, "vault {vi}: destination delta");
        assert_eq!(balance(&env, &refund).unwrap() - r0, fund_amt - amount, "vault {vi}: refund delta");
        assert!(lamports(&env, &rent_to) > l0, "vault {vi}: rent_to got nothing");
        assert_spent_and_closed(&env, &v, &format!("vault {vi}"));
        moved_total += fund_amt as u128;
        valid_ok += 1;
        // Replay after spend: the valid data, then a mutated copy.
        let ix = ix_of(&v, metas(&env, &v, dest, refund, rent_to), valid.clone());
        expect_code(env.exec(&[&v.owner], &[cu_limit(), ix]), 8, "replay valid after spend");
        let mut d = valid;
        d[18] ^= 1;
        let ix = ix_of(&v, metas(&env, &v, dest, refund, rent_to), d);
        expect_code(env.exec(&[&v.owner], &[cu_limit(), ix]), 8, "replay mutated after spend");
        replays += 2;
    }
    let mutations: usize = per_kind.iter().sum();
    println!("[fuzz] {} cases = {mutations} mutations rejected + {valid_ok} valid spends accepted; {replays} post-spend replays rejected (AlreadySpent); {:.1}s",
        mutations + valid_ok, t0.elapsed().as_secs_f64());
    println!("[fuzz] per mutation kind: {}", names.iter().zip(per_kind).map(|(n, c)| format!("{n}={c}")).collect::<Vec<_>>().join(" "));
    println!("[fuzz] tokens moved by valid spends: {moved_total}");
    assert!(mutations + valid_ok >= n.min(2_000), "fewer cases than requested");
}

// =====================================================================
// 4. Account substitution, order permutations, duplicates
// =====================================================================

/// All 36 pairwise swaps of the nine account metas (flags move with the key,
/// so the owner keeps signing) plus QC_PERMS random permutations around a valid
/// signature: nothing may succeed, nothing may move, the vault stays unspent,
/// and the untouched order still works afterwards.
#[test]
fn accounts_swaps_and_random_permutations_rejected() {
    let mut rng = Rng::from_env(105);
    let mut env = setup(&mut rng);
    let v = new_vault(&mut env, &mut rng, 10_000);
    let dest = token_account(&mut env);
    let refund = token_account(&mut env);
    let rent_to = fresh_addr(&mut env);
    let data = spend_data(&env, &v, dest, refund, rent_to, 4_000);
    let good = metas(&env, &v, dest, refund, rent_to);
    let mut tally: BTreeMap<String, usize> = BTreeMap::new();
    let mut run = |env: &mut Env, acc: Vec<AccountMeta>, what: &str| {
        let r = env.exec(&[&v.owner], &[cu_limit(), ix_of(&v, acc, data.clone())]);
        match r {
            Ok(_) => panic!("{what}: permuted accounts succeeded"),
            Err(f) => *tally.entry(short(&f)).or_default() += 1,
        }
    };
    let mut swaps = 0;
    for i in 0..9 {
        for j in i + 1..9 {
            let mut acc = good.clone();
            acc.swap(i, j);
            run(&mut env, acc, &format!("swap {i}<->{j}"));
            swaps += 1;
        }
    }
    let perms = knob("QC_PERMS", 400);
    let mut done = 0;
    while done < perms {
        let mut acc = good.clone();
        for i in (1..9).rev() { let j = rng.below(i as u64 + 1) as usize; acc.swap(i, j); }
        if acc.iter().zip(&good).all(|(a, b)| a.pubkey == b.pubkey) { continue; }
        run(&mut env, acc, "random permutation");
        done += 1;
    }
    assert_untouched(&env, &v, 10_000, "after permutations");
    assert_eq!(balance(&env, &dest), Some(0));
    env.exec(&[&v.owner], &[cu_limit(), ix_of(&v, good, data)]).expect("original order still works");
    println!("[accounts] {swaps} pairwise swaps + {done} random permutations rejected; errors: {tally:?}");
}

/// Every ordered pair (i, j): account j replaced by a copy of account i (72
/// cases) must fail with DuplicateAccount (6). Eight or ten accounts, and no
/// accounts, fail with BadInstruction (1).
#[test]
fn accounts_duplicates_and_wrong_count_rejected() {
    let mut rng = Rng::from_env(106);
    let mut env = setup(&mut rng);
    let v = new_vault(&mut env, &mut rng, 10_000);
    let dest = token_account(&mut env);
    let refund = token_account(&mut env);
    let rent_to = fresh_addr(&mut env);
    let data = spend_data(&env, &v, dest, refund, rent_to, 4_000);
    let good = metas(&env, &v, dest, refund, rent_to);
    let mut dups = 0;
    for i in 0..9 {
        for j in 0..9 {
            if i == j { continue; }
            let mut acc = good.clone();
            acc[j] = acc[i].clone();
            let signers = signers_for(&acc, &[&v.owner]);
            expect_code(env.exec(&signers, &[cu_limit(), ix_of(&v, acc, data.clone())]), 6, &format!("account {j} := account {i}"));
            dups += 1;
        }
    }
    let mut counts = 0;
    for drop in 0..9 {
        let mut acc = good.clone();
        acc.remove(drop);
        let signers = signers_for(&acc, &[&v.owner]);
        expect_code(env.exec(&signers, &[cu_limit(), ix_of(&v, acc, data.clone())]), 1, &format!("8 accounts (dropped {drop})"));
        counts += 1;
    }
    let extra = fresh_addr(&mut env);
    for extra_meta in [AccountMeta::new_readonly(extra, false), good[3].clone()] {
        let mut acc = good.clone();
        acc.push(extra_meta);
        expect_code(env.exec(&[&v.owner], &[cu_limit(), ix_of(&v, acc, data.clone())]), 1, "10 accounts");
        counts += 1;
    }
    expect_code(env.exec(&[], &[cu_limit(), ix_of(&v, vec![], data.clone())]), 1, "0 accounts");
    counts += 1;
    assert_untouched(&env, &v, 10_000, "after duplicates");
    env.exec(&[&v.owner], &[cu_limit(), ix_of(&v, good, data)]).expect("valid spend after duplicate attempts");
    println!("[accounts] {dups} duplicate-account cases -> Custom(6); {counts} wrong account counts -> Custom(1)");
}

/// Wrong owners and wrong programs, one by one, with the exact expected
/// outcome. Cases that pass the WOTS check and then fail inside a Token-2022
/// CPI must roll back completely (vault unspent, nothing moved).
#[test]
fn wrong_owners_and_programs_rejected() {
    let mut rng = Rng::from_env(107);
    let mut env = setup(&mut rng);
    let v = new_vault(&mut env, &mut rng, 10_000);
    let dest = token_account(&mut env);
    let refund = token_account(&mut env);
    let rent_to = fresh_addr(&mut env);
    let other_mint = new_mint_with(&mut env, 82, vec![]);
    let data = spend_data(&env, &v, dest, refund, rent_to, 4_000);
    let good = metas(&env, &v, dest, refund, rent_to);
    let stranger = rng.kp();
    let mut n = 0usize;
    /// Runs one case: it must fail with `want` (a qc-vault code) or, for None,
    /// with a failure that is not a qc-vault code (Token-2022 / runtime), and
    /// leave the vault untouched.
    fn check(label: &str, acc: Vec<AccountMeta>, d: Vec<u8>, extra: &[&Keypair], want: Option<u32>, v: &Vault, env: &mut Env) -> usize {
        let signers = signers_for(&acc, extra);
        let r = env.exec(&signers, &[cu_limit(), ix_of(v, acc, d)]);
        let f = match r { Ok(cu) => panic!("{label}: succeeded ({cu} CU)"), Err(f) => f };
        match want {
            Some(c) => assert_eq!(code(&f), Some(c), "{label}: {f:?}"),
            None => assert!(not_vault_error(&f), "{label}: expected a Token-2022/runtime failure, got {f:?}"),
        }
        assert_untouched(env, v, 10_000, label);
        println!("[wrong] {label:<62} -> {}", short(&f));
        1
    }
    let with = |k: usize, pk: Address| { let mut a = good.clone(); a[k].pubkey = pk; a };

    n += check("token program = legacy SPL Token", with(6, LEGACY), data.clone(), &[&v.owner], Some(5), &v, &mut env);
    n += check("token program = random address", with(6, Address::new_from_array(rng.arr())), data.clone(), &[&v.owner], Some(5), &v, &mut env);
    n += check("token program = ATA program", with(6, ATA), data.clone(), &[&v.owner], Some(5), &v, &mut env);
    n += check("token program = qc-vault itself", with(6, env.prog), data.clone(), &[&v.owner], Some(5), &v, &mut env);
    n += check("system program = Token-2022 (duplicate of slot 6)", with(8, T22), data.clone(), &[&v.owner], Some(6), &v, &mut env);
    n += check("system program = legacy SPL Token", with(8, LEGACY), data.clone(), &[&v.owner], Some(1), &v, &mut env);
    n += check("system program = random address", with(8, Address::new_from_array(rng.arr())), data.clone(), &[&v.owner], Some(1), &v, &mut env);
    let mut a = good.clone();
    a[7].is_signer = false;
    n += check("owner present but not signer", a, data.clone(), &[], Some(7), &v, &mut env);
    n += check("owner = another signer", with(7, stranger.pubkey()), data.clone(), &[&stranger], Some(2), &v, &mut env);
    n += check("owner = fee payer", with(7, env.payer.pubkey()), data.clone(), &[], Some(2), &v, &mut env);
    let legacy_ata = Address::find_program_address(&[v.pda.as_ref(), LEGACY.as_ref(), env.mint.as_ref()], &ATA).0;
    n += check("vault token account = legacy-program ATA address", with(1, legacy_ata), data.clone(), &[&v.owner], Some(4), &v, &mut env);
    // The vault's real ATA for another mint, funded, with the env mint in slot 2.
    let other_ata = create_ata(&mut env, &v.pda, other_mint);
    mint_to_of(&mut env, other_mint, other_ata, 10_000);
    n += check("vault token account = vault's ATA of another mint", with(1, other_ata), data.clone(), &[&v.owner], Some(4), &v, &mut env);
    n += check("mint = other mint (signature over env mint)", with(2, other_mint), data.clone(), &[&v.owner], Some(2), &v, &mut env);
    let d_other = spend_data_mint(&v, &other_mint, dest, refund, rent_to, 4_000);
    n += check("mint = other mint, signed, real ATA of env mint", with(2, other_mint), d_other, &[&v.owner], Some(4), &v, &mut env);
    n += check("vault = payer (system account)", with(0, env.payer.pubkey()), data.clone(), &[&v.owner], Some(2), &v, &mut env);
    // Same key, other owner: a different vault address.
    let sib = canonical(&env, env.prog, &Key { master: v.master, seed: v.seed, pk: wots::keys::public_key_hash(&v.master, &v.seed) }, &stranger);
    n += check("vault = same WOTS key, other owner's vault", with(0, sib.pda), data.clone(), &[&v.owner], Some(2), &v, &mut env);
    // A second deployment of the same binary.
    let prog2 = Address::new_from_array(rng.arr());
    env.svm.add_program_from_file(prog2, SO).unwrap();
    let r = env.exec(&[&v.owner], &[cu_limit(), Instruction { program_id: prog2, accounts: good.clone(), data: data.clone() }]);
    let f = r.expect_err("cross-deployment replay succeeded");
    assert_eq!(code(&f), Some(2), "cross-deployment: {f:?}");
    assert_untouched(&env, &v, 10_000, "cross-deployment");
    println!("[wrong] {:<62} -> {}", "same accounts/data sent to a second deployment", short(&f));
    n += 1;

    // Wrong owners on token accounts (signed correctly, fail inside Token-2022).
    let foreign_dest = token_account_for(&mut env, other_mint, &Address::new_from_array(rng.arr()));
    let d = spend_data(&env, &v, foreign_dest, refund, rent_to, 4_000);
    n += check("destination = token account of another mint (signed)", metas(&env, &v, foreign_dest, refund, rent_to), d, &[&v.owner], None, &v, &mut env);
    let foreign_refund = token_account_for(&mut env, other_mint, &Address::new_from_array(rng.arr()));
    let d = spend_data(&env, &v, dest, foreign_refund, rent_to, 4_000);
    n += check("refund = token account of another mint (signed)", metas(&env, &v, dest, foreign_refund, rent_to), d, &[&v.owner], None, &v, &mut env);
    let ghost = Address::new_from_array(rng.arr());
    let d = spend_data(&env, &v, ghost, refund, rent_to, 4_000);
    n += check("destination = nonexistent account (signed)", metas(&env, &v, ghost, refund, rent_to), d, &[&v.owner], None, &v, &mut env);
    // A non-Token-2022 account at the destination: a system account with lamports.
    let sys_dest = fresh_addr(&mut env);
    env.svm.airdrop(&sys_dest, 5_000_000).unwrap();
    let d = spend_data(&env, &v, sys_dest, refund, rent_to, 4_000);
    n += check("destination = system-owned account (signed)", metas(&env, &v, sys_dest, refund, rent_to), d, &[&v.owner], None, &v, &mut env);
    // The vault token account handed to another program (simulated with set_account).
    let orig = env.svm.get_account(&v.ta).unwrap();
    let mut fake = orig.clone();
    fake.owner = LEGACY;
    env.svm.set_account(v.ta, fake).unwrap();
    let r = env.exec(&[&v.owner], &[cu_limit(), ix_of(&v, good.clone(), data.clone())]);
    let f = r.expect_err("vault token account owned by another program accepted");
    assert!(not_vault_error(&f), "fake-owner vault token account: {f:?}");
    assert!(!is_spent(&env, &v));
    println!("[wrong] {:<62} -> {}", "vault token account owned by legacy SPL Token (injected)", short(&f));
    env.svm.set_account(v.ta, orig).unwrap();
    n += 1;
    // Writable flags dropped.
    for (k, label) in [(0, "vault"), (1, "vault token account"), (5, "rent_to")] {
        let mut a = good.clone();
        a[k].is_writable = false;
        n += check(&format!("{label} passed read-only"), a, data.clone(), &[&v.owner], None, &v, &mut env);
    }
    // Finally the untouched spend works and moves exactly what it says.
    env.exec(&[&v.owner], &[cu_limit(), ix_of(&v, good, data)]).expect("valid spend after wrong-account attempts");
    assert_eq!(balance(&env, &dest), Some(4_000));
    assert_eq!(balance(&env, &refund), Some(6_000));
    assert_spent_and_closed(&env, &v, "final spend");
    assert_eq!(balance(&env, &other_ata), Some(10_000), "other-mint ATA of a spent vault");
    println!("[wrong] {n} wrong-owner/wrong-program cases rejected; valid spend afterwards OK");
}

/// A prefunded (system-owned, 0-byte) account at the vault's ATA address is
/// refused as NotATokenAccount; the ATA program can still create the real
/// account there afterwards and the spend then works.
#[test]
fn prefunded_ata_address_is_not_a_token_account() {
    let mut rng = Rng::from_env(108);
    let mut env = setup(&mut rng);
    let key = Key::new(&mut rng);
    let owner = rng.kp();
    let p = env.prog;
    let v = canonical(&env, p, &key, &owner);
    env.svm.airdrop(&v.ta, 3_000_000).unwrap();
    let dest = token_account(&mut env);
    let refund = token_account(&mut env);
    let rent_to = fresh_addr(&mut env);
    let data = spend_data(&env, &v, dest, refund, rent_to, 0);
    expect_code(env.exec(&[&owner], &[cu_limit(), ix_of(&v, metas(&env, &v, dest, refund, rent_to), data.clone())]), 4, "prefunded ATA address");
    assert!(!is_spent(&env, &v));
    fund(&mut env, &v, 2_500);
    let data = spend_data(&env, &v, dest, refund, rent_to, 2_500);
    env.exec(&[&owner], &[cu_limit(), ix_of(&v, metas(&env, &v, dest, refund, rent_to), data)]).expect("spend after ATA creation");
    assert_eq!(balance(&env, &dest), Some(2_500));
    println!("[wrong] prefunded system account at the ATA address -> Custom(4); after CreateIdempotent the spend works");
}

// =====================================================================
// 5. Amounts: 0, 1, full, full+1, u64::MAX
// =====================================================================
#[test]
fn amounts_edge_values() {
    let mut rng = Rng::from_env(109);
    let mut env = setup(&mut rng);
    const F: u64 = 1_000_000;
    let dest = token_account(&mut env);
    let refund = token_account(&mut env);
    let ok = |env: &mut Env, rng: &mut Rng, fund_amt: u64, amount: u64, label: &str| {
        let v = new_vault(env, rng, fund_amt);
        let rent_to = fresh_addr(env);
        let (d0, r0) = (balance(env, &dest).unwrap(), balance(env, &refund).unwrap());
        let cu = env.exec(&[&v.owner], &[cu_limit(), spend_ix(env, &v, dest, refund, rent_to, amount)]).unwrap_or_else(|e| panic!("{label}: {e:?}"));
        assert_eq!(balance(env, &dest).unwrap() - d0, amount, "{label}: dest");
        assert_eq!(balance(env, &refund).unwrap() - r0, fund_amt - amount, "{label}: refund");
        assert_spent_and_closed(env, &v, label);
        println!("[amounts] {label:<34} fund={fund_amt:<20} amount={amount:<20} -> OK ({cu} CU)");
    };
    ok(&mut env, &mut rng, F, 0, "amount 0 (all to refund)");
    ok(&mut env, &mut rng, F, 1, "amount 1");
    ok(&mut env, &mut rng, F, F, "amount = full balance");
    ok(&mut env, &mut rng, 0, 0, "empty vault, amount 0");
    let bad = |env: &mut Env, rng: &mut Rng, fund_amt: u64, amount: u64, label: &str| {
        let v = new_vault(env, rng, fund_amt);
        let rent_to = fresh_addr(env);
        expect_code(env.exec(&[&v.owner], &[cu_limit(), spend_ix(env, &v, dest, refund, rent_to, amount)]), 3, label);
        assert_untouched(env, &v, fund_amt, label);
        println!("[amounts] {label:<34} fund={fund_amt:<20} amount={amount:<20} -> Custom(3)");
    };
    bad(&mut env, &mut rng, F, F + 1, "amount = full + 1");
    bad(&mut env, &mut rng, F, u64::MAX, "amount = u64::MAX");
    bad(&mut env, &mut rng, F, 1 << 63, "amount = 2^63");
    bad(&mut env, &mut rng, 0, 1, "empty vault, amount 1");
    // u64::MAX balances need their own mint (supply would overflow otherwise).
    for (amount, label) in [(u64::MAX, "fund u64::MAX, amount u64::MAX"), (u64::MAX - 1, "fund u64::MAX, amount u64::MAX-1"), (1 << 63, "fund u64::MAX, amount 2^63")] {
        let mut e2 = setup(&mut rng);
        let d2 = token_account(&mut e2);
        let r2 = token_account(&mut e2);
        let v = new_vault(&mut e2, &mut rng, u64::MAX);
        let rent_to = fresh_addr(&mut e2);
        let cu = e2.exec(&[&v.owner], &[cu_limit(), spend_ix(&e2, &v, d2, r2, rent_to, amount)]).unwrap_or_else(|e| panic!("{label}: {e:?}"));
        assert_eq!(balance(&e2, &d2), Some(amount));
        assert_eq!(balance(&e2, &r2), Some(u64::MAX - amount));
        assert_spent_and_closed(&e2, &v, label);
        println!("[amounts] {label:<34} -> OK ({cu} CU), dest={amount} refund={}", u64::MAX - amount);
    }
}

// =====================================================================
// 6. Replay after spend
// =====================================================================
#[test]
fn replay_after_spend_rejected() {
    let mut rng = Rng::from_env(110);
    let mut env = setup(&mut rng);
    let v = new_vault(&mut env, &mut rng, 1_000);
    let dest = token_account(&mut env);
    let refund = token_account(&mut env);
    let rent_to = fresh_addr(&mut env);
    let data = spend_data(&env, &v, dest, refund, rent_to, 400);
    let good = metas(&env, &v, dest, refund, rent_to);
    env.exec(&[&v.owner], &[cu_limit(), ix_of(&v, good.clone(), data.clone())]).unwrap();
    assert_spent_and_closed(&env, &v, "first spend");
    // (a) the identical instruction, new blockhash
    expect_code(env.exec(&[&v.owner], &[cu_limit(), ix_of(&v, good.clone(), data.clone())]), 8, "identical replay");
    // (b) attacker-modified amount and recipients
    let mut d = data.clone();
    d[18..26].copy_from_slice(&600u64.to_le_bytes());
    expect_code(env.exec(&[&v.owner], &[cu_limit(), ix_of(&v, good.clone(), d)]), 8, "replay with other amount");
    let evil = token_account(&mut env);
    let mut a = good.clone();
    a[3].pubkey = evil;
    expect_code(env.exec(&[&v.owner], &[cu_limit(), ix_of(&v, a, data.clone())]), 8, "replay to other destination");
    // (c) the ATA re-created and refilled: still refused, tokens stay there
    let m = env.mint;
    create_ata(&mut env, &v.pda, m);
    mint_to(&mut env, v.ta, 5_000);
    expect_code(env.exec(&[&v.owner], &[cu_limit(), ix_of(&v, good.clone(), data.clone())]), 8, "replay on re-created ATA");
    assert_eq!(balance(&env, &v.ta), Some(5_000));
    // (d) lamports sent to the marker do not change its owner
    env.svm.airdrop(&v.pda, 10_000_000).unwrap();
    expect_code(env.exec(&[&v.owner], &[cu_limit(), ix_of(&v, good.clone(), data.clone())]), 8, "replay after topping up the marker");
    // (e) the same transaction against a second deployment
    let prog2 = Address::new_from_array(rng.arr());
    env.svm.add_program_from_file(prog2, SO).unwrap();
    let f = env.exec(&[&v.owner], &[cu_limit(), Instruction { program_id: prog2, accounts: good, data }]).expect_err("cross-deployment replay");
    assert_eq!(code(&f), Some(2), "{f:?}");
    assert_eq!(balance(&env, &dest), Some(400));
    assert_eq!(balance(&env, &evil), Some(0));
    println!("[replay] identical, other amount, other destination, re-created ATA, topped-up marker -> Custom(8); second deployment -> Custom(2)");

    // (f) the same spend twice in ONE transaction: the second fails, the whole tx rolls back
    let w = new_vault(&mut env, &mut rng, 1_000);
    let ix = spend_ix(&env, &w, dest, refund, rent_to, 1_000);
    let f = env.exec(&[&w.owner], &[cu_limit(), ix.clone(), ix.clone()]).expect_err("double spend in one tx");
    assert_eq!(code(&f), Some(8), "{f:?}");
    assert!(f.err.contains("InstructionError(2"), "second instruction must be the failing one: {}", f.err);
    assert_untouched(&env, &w, 1_000, "double spend in one tx");
    env.exec(&[&w.owner], &[cu_limit(), ix]).expect("single spend after rolled-back double");
    // (g) two different vaults in one transaction both work
    let x = new_vault(&mut env, &mut rng, 300);
    let y = new_vault(&mut env, &mut rng, 700);
    let (ix1, ix2) = (spend_ix(&env, &x, dest, refund, rent_to, 300), spend_ix(&env, &y, dest, refund, rent_to, 0));
    env.exec(&[&x.owner, &y.owner], &[cu_limit(), ix1, ix2]).expect("two vaults in one tx");
    assert!(is_spent(&env, &x) && is_spent(&env, &y));
    println!("[replay] same spend twice in one tx -> InstructionError(2, Custom(8)), rolled back; two vaults in one tx -> OK");
}

// =====================================================================
// 7. WOTS key reuse across vaults and owners
// =====================================================================

/// One WOTS key, several owners. The program binds a vault to (pk_hash, owner),
/// and the canonical-bump fix makes that one address per pair. Reusing the key
/// across owners is NOT prevented on chain: each owner's vault is a different
/// address with its own spent marker. This test shows (1) a signature cannot be
/// transplanted between the sibling vaults, (2) each sibling can be spent with
/// its own signature, and (3) once several siblings have spent, an attacker who
/// can also forge the last owner's Ed25519 signature (the post-quantum threat
/// model; the test simply holds that key) may combine the published WOTS
/// signatures into a forgery for the last sibling.
#[test]
fn wots_key_reuse_across_vaults_and_owners() {
    let mut rng = Rng::from_env(111);
    let mut env = setup(&mut rng);
    let key = Key::new(&mut rng);
    let owners: Vec<Keypair> = (0..6).map(|_| rng.kp()).collect();
    let p = env.prog;
    let vaults: Vec<Vault> = owners.iter().map(|o| canonical(&env, p, &key, o)).collect();
    for i in 0..vaults.len() { for j in i + 1..vaults.len() { assert_ne!(vaults[i].pda, vaults[j].pda); } }
    for v in &vaults { fund(&mut env, v, 1_000_000); }
    let dest = token_account(&mut env);
    let refund = token_account(&mut env);
    let rent_to = fresh_addr(&mut env);

    // (1) transplant: vault 0's signed data on vault 1's accounts / with owner 1
    let d0 = spend_data(&env, &vaults[0], dest, refund, rent_to, 10);
    expect_code(env.exec(&[&vaults[1].owner], &[cu_limit(), ix_of(&vaults[1], metas(&env, &vaults[1], dest, refund, rent_to), d0.clone())]), 2, "sig of vault 0 on vault 1");
    let mut a = metas(&env, &vaults[0], dest, refund, rent_to);
    a[7].pubkey = vaults[1].owner.pubkey();
    expect_code(env.exec(&[&vaults[1].owner], &[cu_limit(), ix_of(&vaults[0], a, d0)]), 2, "vault 0 with owner 1");
    println!("[reuse] signature transplant between same-key vaults of two owners -> Custom(2)");

    // (2)+(3): legit spends one after another; after each, try to forge for the last vault.
    let attacker_dest = token_account(&mut env);
    let attacker_refund = token_account(&mut env);
    let attacker_rent = fresh_addr(&mut env);
    let target = vaults.last().unwrap();
    let tries = knob("QC_FORGE_TRIES", 400_000) as u64;
    let mut published: Vec<([u8; wots::CHAINS], Vec<u8>)> = vec![];
    for (s, v) in vaults[..vaults.len() - 1].iter().enumerate() {
        let amount = 1_000 + s as u64;
        let digest = digest_of(v, &env.mint, &dest, &refund, &rent_to, amount);
        let sig = wots::keys::sign(&v.master, &v.seed, &digest);
        env.exec(&[&v.owner], &[cu_limit(), ix_of(v, metas(&env, v, dest, refund, rent_to), data_from_sig(v.bump, &v.seed, amount, &sig))])
            .expect("same-key sibling spend accepted");
        assert_spent_and_closed(&env, v, "same-key sibling");
        published.push((wots::digits(&digest), sig.to_vec()));
        if published.len() < 2 { continue; }
        // Per chain, the lowest published position. Any digest whose 26 digits
        // are all >= these can be signed by walking chains forward: no secret.
        let mins: Vec<(u8, usize)> = (0..wots::CHAINS)
            .map(|i| published.iter().enumerate().map(|(j, (dg, _))| (dg[i], j)).min().unwrap()).collect();
        let t0 = std::time::Instant::now();
        let mut best = 0usize;
        let mut hit = None;
        for t in 0..tries {
            let amt = 1 + t; // the attacker grinds the amount (rent_to could be ground as well)
            let dg = wots::digits(&digest_of(target, &env.mint, &attacker_dest, &attacker_refund, &attacker_rent, amt));
            let ok = (0..wots::CHAINS).filter(|&i| dg[i] >= mins[i].0).count();
            best = best.max(ok);
            if ok == wots::CHAINS { hit = Some((amt, dg, t + 1)); break; }
        }
        let Some((amt, dg, n_tries)) = hit else {
            println!("[reuse] after {} same-key spends: no forgeable digest for the last sibling in {tries} tries (best {best}/26 chains), {:.1}s",
                published.len(), t0.elapsed().as_secs_f64());
            continue;
        };
        let mut fsig = vec![0u8; wots::SIG_LEN];
        for i in 0..wots::CHAINS {
            let (m, j) = mins[i];
            let start: [u8; 24] = published[j].1[i * 24..i * 24 + 24].try_into().unwrap();
            fsig[i * 24..i * 24 + 24].copy_from_slice(&wots::chain(&key.seed, i as u8, m, dg[i], &start));
        }
        let d = data_from_sig(target.bump, &key.seed, amt, &fsig);
        let cu = env.exec(&[&target.owner], &[cu_limit(), ix_of(target, metas(&env, target, attacker_dest, attacker_refund, attacker_rent), d)])
            .expect("forged signature from published same-key signatures must verify (WOTS math)");
        assert_eq!(balance(&env, &attacker_dest), Some(amt));
        assert_eq!(balance(&env, &attacker_refund), Some(1_000_000 - amt));
        println!("[reuse] after {} same-key spends by other owners: FORGED WOTS signature drained the last sibling vault (amount {amt} + refund {} to attacker accounts; found after {n_tries} tries, {:.1}s, {cu} CU). Ed25519 of that owner assumed broken.",
            published.len(), 1_000_000 - amt, t0.elapsed().as_secs_f64());
        return;
    }
    println!("[reuse] no forgery found within the budget; siblings each spent once with their own signature");
}
