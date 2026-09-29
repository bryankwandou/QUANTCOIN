//! Second-round audit (AUDIT-2): randomized / property tests against the
//! deployed binary (`target/deploy/qc_vault.so`) inside LiteSVM, plus native
//! property tests of the WOTS code. No external fuzzing crate: a seeded
//! xorshift PRNG keeps runs reproducible (set QC_FUZZ_SEED / QC_FUZZ_CASES).
use litesvm::LiteSVM;
use qc_vault::{spend_digest, wots, VAULT_SEED};
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

const T22: Address = Address::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const CB: Address = Address::from_str_const("ComputeBudget111111111111111111111111111111");
const DECIMALS: u8 = 5;

// ---------- deterministic PRNG ----------
struct Rng(u64);
impl Rng {
    fn from_env(salt: u64) -> Self {
        let s = std::env::var("QC_FUZZ_SEED").ok().and_then(|v| v.parse().ok()).unwrap_or(0x9E37_79B9_7F4A_7C15u64);
        println!("fuzz seed {s} (salt {salt})");
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
}
fn cases(default: usize) -> usize {
    std::env::var("QC_FUZZ_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

// ---------- LiteSVM harness (same as tests/vault.rs) ----------
struct Env { svm: LiteSVM, prog: Address, payer: Keypair, mint: Address }
struct Vault { master: [u8; 32], seed: [u8; 16], owner: Keypair, pda: Address, bump: u8, ta: Address }

fn send(svm: &mut LiteSVM, payer: &Keypair, extra: &[&Keypair], ixs: &[Instruction]) -> Result<u64, String> {
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra);
    let tx = Transaction::new(&signers, Message::new(ixs, Some(&payer.pubkey())), svm.latest_blockhash());
    svm.send_transaction(tx)
        .map(|m| m.compute_units_consumed)
        .map_err(|e| format!("{:?} CU={}\n{}", e.err, e.meta.compute_units_consumed, e.meta.logs.join("\n")))
}
fn send_cu(svm: &mut LiteSVM, payer: &Keypair, extra: &[&Keypair], ixs: &[Instruction]) -> (bool, u64) {
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra);
    let tx = Transaction::new(&signers, Message::new(ixs, Some(&payer.pubkey())), svm.latest_blockhash());
    match svm.send_transaction(tx) {
        Ok(m) => (true, m.compute_units_consumed),
        Err(e) => (false, e.meta.compute_units_consumed),
    }
}
fn create(svm: &mut LiteSVM, payer: &Keypair, kp: &Keypair, space: u64, owner: &Address) {
    let lamports = svm.minimum_balance_for_rent_exemption(space as usize);
    let ix = solana_system_interface::instruction::create_account(&payer.pubkey(), &kp.pubkey(), lamports, space, owner);
    send(svm, payer, &[kp], &[ix]).unwrap();
}
fn token_account_sized(env: &mut Env, owner: &Address, space: u64) -> Address {
    let kp = Keypair::new();
    create(&mut env.svm, &env.payer, &kp, space, &T22);
    let mut d = vec![18u8];
    d.extend_from_slice(owner.as_ref());
    let ix = Instruction::new_with_bytes(T22, &d,
        vec![AccountMeta::new(kp.pubkey(), false), AccountMeta::new_readonly(env.mint, false)]);
    let payer = env.payer.insecure_clone();
    send(&mut env.svm, &payer, &[], &[ix]).unwrap();
    kp.pubkey()
}
fn token_account(env: &mut Env, owner: &Address) -> Address { token_account_sized(env, owner, 165) }
fn balance(svm: &LiteSVM, ta: &Address) -> Option<u64> {
    svm.get_account(ta).filter(|a| a.lamports > 0).map(|a| u64::from_le_bytes(a.data[64..72].try_into().unwrap()))
}
fn setup_with_mint(mint_space: u64, pre: Vec<u8>) -> Env {
    let mut svm = LiteSVM::new();
    let prog = Address::new_unique();
    svm.add_program_from_file(prog, concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/qc_vault.so")).unwrap();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 1_000_000_000_000).unwrap();
    let mint_kp = Keypair::new();
    create(&mut svm, &payer, &mint_kp, mint_space, &T22);
    let mut ixs = vec![];
    if !pre.is_empty() {
        ixs.push(Instruction::new_with_bytes(T22, &pre, vec![AccountMeta::new(mint_kp.pubkey(), false)]));
    }
    let mut d = vec![20u8, DECIMALS];
    d.extend_from_slice(payer.pubkey().as_ref());
    d.push(0);
    ixs.push(Instruction::new_with_bytes(T22, &d, vec![AccountMeta::new(mint_kp.pubkey(), false)]));
    send(&mut svm, &payer, &[], &ixs).unwrap();
    Env { svm, prog, payer, mint: mint_kp.pubkey() }
}
fn setup() -> Env { setup_with_mint(82, vec![]) }
fn mint_to(env: &mut Env, ta: Address, amount: u64) {
    let mut d = vec![14u8];
    d.extend_from_slice(&amount.to_le_bytes());
    d.push(DECIMALS);
    let ix = Instruction::new_with_bytes(T22, &d, vec![
        AccountMeta::new(env.mint, false), AccountMeta::new(ta, false), AccountMeta::new_readonly(env.payer.pubkey(), true)]);
    let payer = env.payer.insecure_clone();
    send(&mut env.svm, &payer, &[], &[ix]).unwrap();
}
fn new_vault_sized(env: &mut Env, rng: &mut Rng, fund: u64, space: u64) -> Vault {
    let master: [u8; 32] = rng.arr();
    let seed: [u8; 16] = rng.arr();
    let owner = Keypair::new();
    let pk = wots::keys::public_key_hash(&master, &seed);
    let (pda, bump) = Address::find_program_address(&[VAULT_SEED, &pk, owner.pubkey().as_ref()], &env.prog);
    let ta = token_account_sized(env, &pda, space);
    if fund > 0 { mint_to(env, ta, fund); }
    Vault { master, seed, owner, pda, bump, ta }
}
fn new_vault(env: &mut Env, rng: &mut Rng, fund: u64) -> Vault { new_vault_sized(env, rng, fund, 165) }
fn spend_data(env: &Env, v: &Vault, dest: Address, refund: Address, rent_to: Address, amount: u64) -> Vec<u8> {
    let digest = spend_digest(env.prog.as_array(), v.pda.as_array(), env.mint.as_array(), dest.as_array(),
        refund.as_array(), rent_to.as_array(), amount);
    let sig = wots::keys::sign(&v.master, &v.seed, &digest);
    let mut d = vec![0u8, v.bump];
    d.extend_from_slice(&v.seed);
    d.extend_from_slice(&amount.to_le_bytes());
    d.extend_from_slice(&sig);
    d
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
        AccountMeta::new_readonly(Address::default(), false),
    ]
}
fn cu_limit() -> Instruction {
    let mut d = vec![2u8];
    d.extend_from_slice(&1_400_000u32.to_le_bytes());
    Instruction::new_with_bytes(CB, &d, vec![])
}
fn steps_of(d: &[u8; 24]) -> u64 { wots::digits(d).iter().map(|x| 255 - *x as u64).sum() }

// =====================================================================
// 1. Native WOTS properties
// =====================================================================

/// Checksum soundness: for any two distinct digests a != b, the digit vector
/// of b is lower than a's in at least one of the 26 positions, so a
/// signature on a (which reveals chain values at digits(a)) cannot be walked
/// FORWARD to a signature on b. Random pairs + all single-digit increments.
#[test]
fn prop_checksum_no_domination() {
    let mut rng = Rng::from_env(1);
    let dominated = |a: &[u8; 24], b: &[u8; 24]| {
        let (da, db) = (wots::digits(a), wots::digits(b));
        da.iter().zip(db.iter()).all(|(x, y)| y >= x)
    };
    for _ in 0..cases(200_000) {
        let a: [u8; 24] = rng.arr();
        let mut b: [u8; 24] = rng.arr();
        if rng.below(2) == 0 { b = a; let k = rng.below(24) as usize; b[k] = b[k].wrapping_add(1 + rng.below(255) as u8); }
        if a != b { assert!(!dominated(&a, &b), "forgery possible: {a:?} -> {b:?}"); }
    }
    // Adversarial neighbours: raise any subset of digits by small amounts.
    for _ in 0..cases(200_000) {
        let a: [u8; 24] = rng.arr();
        let mut b = a;
        for k in 0..24 { if rng.below(4) == 0 { b[k] = b[k].saturating_add(rng.below(3) as u8); } }
        if a != b { assert!(!dominated(&a, &b)); }
    }
    // Extremes: all-zero (max checksum) and all-0xff (checksum 0).
    assert_eq!(wots::digits(&[0; 24])[24..], [23, 232]);
    assert_eq!(wots::digits(&[255; 24])[24..], [0, 0]);
}

/// Max hash steps on-chain is 255*hi + 510 with hi = csum>>8 <= 23 -> 6375.
#[test]
fn prop_max_steps_is_6375() {
    let mut rng = Rng::from_env(2);
    let mut max = 0;
    for _ in 0..cases(200_000) { max = max.max(steps_of(&rng.arr())); }
    assert!(max <= 6375);
    assert_eq!(steps_of(&[0; 24]), 6375);
    // Any digest with byte-sum <= 232 (csum >= 5888, hi = 23) also hits the max.
    let mut d = [0u8; 24]; d[0] = 232;
    assert_eq!(steps_of(&d), 6375);
}

/// Independent re-implementation of the spec (sha2 directly, no wots.rs
/// helpers) versus wots.rs sign/recover on random keys and digests.
#[test]
fn differential_sign_verify() {
    use sha2::{Digest, Sha256};
    fn h(parts: &[&[u8]]) -> [u8; 32] { let mut s = Sha256::new(); for p in parts { s.update(p); } s.finalize().into() }
    fn ref_chain(seed: &[u8], i: u8, from: u8, to: u8, x: &[u8]) -> Vec<u8> {
        let mut v = x.to_vec();
        for s in from..to { v = h(&[b"QCV1/chain", seed, &[i, s], &v])[..24].to_vec(); }
        v
    }
    fn ref_digits(d: &[u8]) -> Vec<u8> {
        let c: u32 = d.iter().map(|x| 255 - *x as u32).sum();
        let mut o = d.to_vec(); o.push((c >> 8) as u8); o.push(c as u8); o
    }
    let mut rng = Rng::from_env(3);
    for _ in 0..cases(300) {
        let master: [u8; 32] = rng.arr();
        let seed: [u8; 16] = rng.arr();
        let digest: [u8; 24] = rng.arr();
        let sig = wots::keys::sign(&master, &seed, &digest);
        // reference signature and public key
        let dg = ref_digits(&digest);
        let mut rsig = vec![]; let mut ends = vec![];
        for i in 0..26u8 {
            let sk = h(&[b"QCV1/sk", &master, &[i]])[..24].to_vec();
            rsig.extend(ref_chain(&seed, i, 0, dg[i as usize], &sk));
            ends.extend(ref_chain(&seed, i, 0, 255, &sk));
        }
        let rpk = h(&[b"QCV1/pk", &seed, &ends]);
        assert_eq!(sig.to_vec(), rsig);
        assert_eq!(wots::keys::public_key_hash(&master, &seed), rpk);
        assert_eq!(wots::recover_pk_hash(&seed, &digest, &sig), rpk);
        // any other digest must not verify
        let mut other = digest; other[rng.below(24) as usize] ^= 1 << rng.below(8);
        assert_ne!(wots::recover_pk_hash(&seed, &other, &sig), rpk);
        // any single-bit signature mutation must not verify
        let mut bad = sig; let k = rng.below(bad.len() as u64) as usize; bad[k] ^= 1 << rng.below(8);
        assert_ne!(wots::recover_pk_hash(&seed, &digest, &bad), rpk);
    }
}

/// PDA seeds are fixed-length (3 + 32 + 32 + 1), so no two (pk_hash, owner)
/// pairs can concatenate to the same preimage.
#[test]
fn prop_seed_layout_injective() {
    assert_eq!(VAULT_SEED.len(), 3);
    let mut rng = Rng::from_env(4);
    let prog = Address::new_unique();
    for _ in 0..cases(200) {
        let (a, o): ([u8; 32], [u8; 32]) = (rng.arr(), rng.arr());
        let (mut a2, mut o2) = (a, o);
        // shifting a byte between the two seeds must change the PDA
        a2.rotate_left(1); o2.rotate_right(1);
        let p1 = Address::find_program_address(&[VAULT_SEED, &a, &o], &prog).0;
        let p2 = Address::find_program_address(&[VAULT_SEED, &a2, &o2], &prog).0;
        assert_ne!(p1, p2);
    }
}

// =====================================================================
// 2. On-chain fuzzing (deployed binary in LiteSVM)
// =====================================================================

/// Random instruction data of random length (0..1100) with correct accounts
/// and a real owner signature: must never succeed or move funds.
#[test]
fn fuzz_parser_random_data() {
    let mut rng = Rng::from_env(5);
    let mut env = setup();
    let v = new_vault(&mut env, &mut rng, 1_000);
    let dest = token_account(&mut env, &Address::new_unique());
    let refund = token_account(&mut env, &Address::new_unique());
    let rent_to = Address::new_unique();
    let payer = env.payer.insecure_clone();
    let valid = spend_data(&env, &v, dest, refund, rent_to, 1_000);
    let n = cases(3_000);
    for i in 0..n {
        let data = match i % 4 {
            // fully random length and bytes
            0 => { let mut d = vec![0u8; rng.below(1_100) as usize]; rng.fill(&mut d); d }
            // exact length, random bytes, correct discriminator
            1 => { let mut d = vec![0u8; valid.len()]; rng.fill(&mut d); d[0] = 0; d }
            // valid header, random signature
            2 => { let mut d = valid.clone(); rng.fill(&mut d[26..]); d }
            // truncated / extended valid data
            _ => { let mut d = valid.clone(); let l = rng.below(valid.len() as u64 * 2) as usize;
                   if l != valid.len() { d.resize(l, rng.u64() as u8); } else { d[0] = 1 + rng.below(255) as u8; } d }
        };
        let ix = Instruction { program_id: env.prog, accounts: metas(&env, &v, dest, refund, rent_to), data };
        let r = send(&mut env.svm, &payer, &[&v.owner], &[cu_limit(), ix]);
        assert!(r.is_err(), "case {i}: random data succeeded");
        env.svm.expire_blockhash();
    }
    assert_eq!(balance(&env.svm, &v.ta), Some(1_000));
    assert_eq!(balance(&env.svm, &dest), Some(0));
    // sanity: the untouched valid spend still works
    let ix = Instruction { program_id: env.prog, accounts: metas(&env, &v, dest, refund, rent_to), data: valid };
    send(&mut env.svm, &payer, &[&v.owner], &[cu_limit(), ix]).unwrap();
    println!("{n} random-data cases rejected");
}

/// Random 1..4 byte mutations anywhere in bytes 1..650 of a VALID spend
/// (bump, seed, amount, signature): must fail with BadSignature (2) or
/// InsufficientBalance (3, amount raised) and never move funds.
#[test]
fn fuzz_signature_mutations() {
    let mut rng = Rng::from_env(6);
    let mut env = setup();
    let v = new_vault(&mut env, &mut rng, 1_000_000);
    let dest = token_account(&mut env, &Address::new_unique());
    let refund = token_account(&mut env, &Address::new_unique());
    let rent_to = Address::new_unique();
    let payer = env.payer.insecure_clone();
    let valid = spend_data(&env, &v, dest, refund, rent_to, 500_000);
    let n = cases(3_000);
    for i in 0..n {
        let mut d = valid.clone();
        for _ in 0..1 + rng.below(4) {
            let k = 1 + rng.below(649) as usize;
            let x = 1 + rng.below(255) as u8;
            d[k] ^= x;
        }
        if d == valid { continue; }
        let ix = Instruction { program_id: env.prog, accounts: metas(&env, &v, dest, refund, rent_to), data: d };
        let e = send(&mut env.svm, &payer, &[&v.owner], &[cu_limit(), ix]).expect_err("mutated signature accepted");
        assert!(e.contains("Custom(2)") || e.contains("Custom(3)"), "case {i}: unexpected error {e}");
        env.svm.expire_blockhash();
    }
    assert_eq!(balance(&env.svm, &v.ta), Some(1_000_000));
    println!("{n} signature mutations rejected");
}

/// Random substitution / permutation of the 9 accounts around a valid
/// signature, with every plausible signer present. Nothing may succeed
/// except the exact original account list.
#[test]
fn fuzz_account_substitution() {
    let mut rng = Rng::from_env(7);
    let mut env = setup();
    let v = new_vault(&mut env, &mut rng, 10_000);
    let dest = token_account(&mut env, &Address::new_unique());
    let refund = token_account(&mut env, &Address::new_unique());
    let attacker = Keypair::new();
    let evil = token_account(&mut env, &attacker.pubkey());
    let rent_to = Address::new_unique();
    let payer = env.payer.insecure_clone();
    let valid = spend_data(&env, &v, dest, refund, rent_to, 4_000);
    let good = metas(&env, &v, dest, refund, rent_to);
    let pool = [v.pda, v.ta, env.mint, dest, refund, rent_to, T22, v.owner.pubkey(), Address::default(), evil, attacker.pubkey(),
        payer.pubkey(), Address::new_unique(), Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")];
    let n = cases(1_500);
    let mut ran = 0;
    for _ in 0..n {
        let mut acc = good.clone();
        match rng.below(3) {
            0 => { let k = rng.below(9) as usize; acc[k].pubkey = pool[rng.below(pool.len() as u64) as usize]; }
            1 => { let (a, b) = (rng.below(9) as usize, rng.below(9) as usize); let t = acc[a].pubkey; acc[a].pubkey = acc[b].pubkey; acc[b].pubkey = t; }
            _ => { for k in 0..9 { if rng.below(3) == 0 { acc[k].pubkey = pool[rng.below(pool.len() as u64) as usize]; } } }
        }
        if rng.below(5) == 0 { let k = rng.below(9) as usize; acc[k].is_signer = !acc[k].is_signer; }
        if acc.iter().zip(good.iter()).all(|(a, b)| a.pubkey == b.pubkey && a.is_signer == b.is_signer) { continue; }
        // sign with whichever of our keys are marked signer
        let mut signers: Vec<&Keypair> = vec![];
        for a in &acc {
            if a.is_signer {
                if a.pubkey == v.owner.pubkey() { signers.push(&v.owner) }
                else if a.pubkey == attacker.pubkey() { signers.push(&attacker) }
                else if a.pubkey != payer.pubkey() { signers.clear(); break; }
            }
        }
        if acc.iter().any(|a| a.is_signer && a.pubkey != payer.pubkey() && a.pubkey != v.owner.pubkey() && a.pubkey != attacker.pubkey()) { continue; }
        signers.dedup_by_key(|k| k.pubkey());
        let ix = Instruction { program_id: env.prog, accounts: acc.clone(), data: valid.clone() };
        let r = send(&mut env.svm, &payer, &signers, &[cu_limit(), ix]);
        assert!(r.is_err(), "account substitution succeeded: {:?}", acc.iter().map(|a| a.pubkey).collect::<Vec<_>>());
        ran += 1;
        env.svm.expire_blockhash();
    }
    assert_eq!(balance(&env.svm, &v.ta), Some(10_000));
    assert_eq!(balance(&env.svm, &evil), Some(0));
    println!("{ran} account substitutions rejected");
}

// =====================================================================
// 3. Compute: grind a digest near the worst case and measure real CU
// =====================================================================
#[test]
fn compute_worst_case_measured() {
    let mut rng = Rng::from_env(8);
    let mut env = setup();
    let fund = u64::MAX / 2;
    let v = new_vault(&mut env, &mut rng, fund);
    let dest = token_account(&mut env, &Address::new_unique());
    let refund = token_account(&mut env, &Address::new_unique());
    let rent_to = Address::new_unique();
    let payer = env.payer.insecure_clone();
    // 1) Linear model from invalid-signature runs (all 26 chains still hashed).
    let mut pts = vec![];
    for _ in 0..40 {
        let amount = 1 + rng.below(1_000_000);
        let mut d = spend_data(&env, &v, dest, refund, rent_to, amount);
        d[30] ^= 1; // break the signature, keep the digest
        let dig = spend_digest(env.prog.as_array(), v.pda.as_array(), env.mint.as_array(), dest.as_array(),
            refund.as_array(), rent_to.as_array(), amount);
        let ix = Instruction { program_id: env.prog, accounts: metas(&env, &v, dest, refund, rent_to), data: d };
        let (ok, cu) = send_cu(&mut env.svm, &payer, &[&v.owner], &[cu_limit(), ix]);
        assert!(!ok);
        pts.push((steps_of(&dig) as f64, cu as f64));
        env.svm.expire_blockhash();
    }
    let n = pts.len() as f64;
    let (mx, my) = (pts.iter().map(|p| p.0).sum::<f64>() / n, pts.iter().map(|p| p.1).sum::<f64>() / n);
    let b = pts.iter().map(|p| (p.0 - mx) * (p.1 - my)).sum::<f64>() / pts.iter().map(|p| (p.0 - mx).powi(2)).sum::<f64>();
    let a = my - b * mx;
    // 2) Grind amounts for the heaviest digest we can find, then run it VALID.
    let (mut best, mut best_amt) = (0u64, 1u64);
    for amt in 1..cases(3_000_000) as u64 {
        let dig = spend_digest(env.prog.as_array(), v.pda.as_array(), env.mint.as_array(), dest.as_array(),
            refund.as_array(), rent_to.as_array(), amt);
        let s = steps_of(&dig);
        if s > best { best = s; best_amt = amt; }
    }
    let ix = Instruction { program_id: env.prog, accounts: metas(&env, &v, dest, refund, rent_to),
        data: spend_data(&env, &v, dest, refund, rent_to, best_amt) };
    let cu = send(&mut env.svm, &payer, &[&v.owner], &[cu_limit(), ix]).expect("heaviest ground spend must succeed");
    let overhead = cu as f64 - (a + b * best as f64);
    let worst = a + b * 6375.0 + overhead;
    println!("CU model: {a:.0} + {b:.2}*steps (verify-only); valid-spend CPI overhead {overhead:.0}");
    println!("heaviest ground digest: {best} steps -> measured {cu} CU (valid spend, 3 CPIs)");
    println!("projected worst case (6375 steps, valid spend): {worst:.0} CU of 1,400,000");
    assert!(worst < 1_400_000.0);
}

// =====================================================================
// 4. Findings
// =====================================================================

/// FINDING M-1 (fixed): the vault token account is not bound into the signed
/// digest, so before the fix one WOTS signature could be replayed against a
/// token account created later for the same vault. Now a spend marks the
/// vault PDA as spent (assigned to the program) and every later spend is
/// refused with AlreadySpent, even with a valid owner signature (i.e. even if
/// a quantum computer forges Ed25519).
#[test]
fn m1_replay_on_second_token_account_is_refused() {
    let mut rng = Rng::from_env(9);
    let mut env = setup();
    let v = new_vault(&mut env, &mut rng, 1_000);
    let dest = token_account(&mut env, &Address::new_unique());
    let refund = token_account(&mut env, &Address::new_unique());
    let rent_to = Address::new_unique();
    let payer = env.payer.insecure_clone();
    let data = spend_data(&env, &v, dest, refund, rent_to, 400);
    let ix = Instruction { program_id: env.prog, accounts: metas(&env, &v, dest, refund, rent_to), data: data.clone() };
    send(&mut env.svm, &payer, &[&v.owner], &[cu_limit(), ix]).unwrap();
    // Spent marker: the vault PDA is owned by the program, rent-exempt, empty.
    let marker = env.svm.get_account(&v.pda).unwrap();
    assert_eq!(marker.owner, env.prog);
    assert_eq!(marker.lamports, qc_vault::MARKER_RENT);
    assert!(marker.data.is_empty());
    // The closed account's rent above the marker minimum reached rent_to.
    assert!(env.svm.get_account(&rent_to).map_or(0, |a| a.lamports) > 0);
    // Someone later deposits into a new token account owned by the spent vault.
    let second = token_account(&mut env, &v.pda);
    mint_to(&mut env, second, 5_000);
    let mut acc = metas(&env, &v, dest, refund, rent_to);
    acc[1].pubkey = second;
    env.svm.expire_blockhash();
    let r = send(&mut env.svm, &payer, &[&v.owner], &[cu_limit(), Instruction { program_id: env.prog, accounts: acc, data: data.clone() }]);
    assert!(r.is_err(), "replay moved funds");
    assert!(r.unwrap_err().contains("0x8"), "expected AlreadySpent");
    assert_eq!(balance(&env.svm, &second), Some(5_000));
    assert_eq!(balance(&env.svm, &dest), Some(400));
    // Same for the original ATA re-created at the same address.
    env.svm.expire_blockhash();
    let ix = Instruction { program_id: env.prog, accounts: metas(&env, &v, dest, refund, rent_to), data };
    assert!(send(&mut env.svm, &payer, &[&v.owner], &[cu_limit(), ix]).is_err());
}

/// Lamports sent to the vault PDA before its spend (griefing) do not block it;
/// the surplus goes to rent_to.
#[test]
fn prefunded_vault_pda_still_spends() {
    let mut rng = Rng::from_env(12);
    let mut env = setup();
    let v = new_vault(&mut env, &mut rng, 1_000);
    let payer = env.payer.insecure_clone();
    env.svm.airdrop(&v.pda, 5_000_000).unwrap();
    let dest = token_account(&mut env, &Address::new_unique());
    let refund = token_account(&mut env, &Address::new_unique());
    let rent_to = Address::new_unique();
    let ix = Instruction { program_id: env.prog, accounts: metas(&env, &v, dest, refund, rent_to),
        data: spend_data(&env, &v, dest, refund, rent_to, 1_000) };
    send(&mut env.svm, &payer, &[&v.owner], &[cu_limit(), ix]).unwrap();
    assert_eq!(env.svm.get_account(&v.pda).unwrap().lamports, qc_vault::MARKER_RENT);
    assert!(env.svm.get_account(&rent_to).unwrap().lamports > 5_000_000 - qc_vault::MARKER_RENT);
}

/// A fake system program is refused.
#[test]
fn rejects_fake_system_program() {
    let mut rng = Rng::from_env(13);
    let mut env = setup();
    let v = new_vault(&mut env, &mut rng, 1_000);
    let payer = env.payer.insecure_clone();
    let dest = token_account(&mut env, &Address::new_unique());
    let refund = token_account(&mut env, &Address::new_unique());
    let rent_to = Address::new_unique();
    let mut acc = metas(&env, &v, dest, refund, rent_to);
    acc[8].pubkey = Address::new_unique();
    let ix = Instruction { program_id: env.prog, accounts: acc, data: spend_data(&env, &v, dest, refund, rent_to, 1_000) };
    assert!(send(&mut env.svm, &payer, &[&v.owner], &[cu_limit(), ix]).is_err());
    assert_eq!(balance(&env.svm, &v.ta), Some(1_000));
}

/// Destination owned by the vault PDA itself: legal, and the funds land in
/// a token account of a spent vault: locked for good. Clients must refuse destinations/refunds owned by the
/// spending vault.
#[test]
fn destination_owned_by_same_vault_is_accepted() {
    let mut rng = Rng::from_env(11);
    let mut env = setup();
    let v = new_vault(&mut env, &mut rng, 1_000);
    let self_owned = token_account(&mut env, &v.pda);
    let refund = token_account(&mut env, &Address::new_unique());
    let rent_to = Address::new_unique();
    let payer = env.payer.insecure_clone();
    let ix = Instruction { program_id: env.prog, accounts: metas(&env, &v, self_owned, refund, rent_to),
        data: spend_data(&env, &v, self_owned, refund, rent_to, 1_000) };
    send(&mut env.svm, &payer, &[&v.owner], &[cu_limit(), ix]).unwrap();
    assert_eq!(balance(&env.svm, &self_owned), Some(1_000));
    assert_eq!(balance(&env.svm, &v.ta), None);
}

/// Transfer-fee mint: deposits leave withheld fees on the vault token
/// account, so CloseAccount (and the whole spend) fails. Not a permanent
/// lock: HarvestWithheldTokensToMint is permissionless. QC's mint has no
/// transfer-fee extension; relevant only if the program is used with
/// other mints.
#[test]
fn transfer_fee_mint_blocks_spend_until_harvest() {
    // InitializeTransferFeeConfig: [26, 0, None, None, bps u16, max u64]
    let mut pre = vec![26u8, 0, 0, 0];
    pre.extend_from_slice(&100u16.to_le_bytes());
    pre.extend_from_slice(&u64::MAX.to_le_bytes());
    let mut env = setup_with_mint(278, pre);
    let mut rng = Rng::from_env(12);
    let src_owner = Keypair::new();
    let src = token_account_sized(&mut env, &src_owner.pubkey(), 178);
    mint_to(&mut env, src, 100_000);
    let v = new_vault_sized(&mut env, &mut rng, 0, 178);
    // deposit via TransferChecked -> 1% withheld on the vault token account
    let mut d = vec![12u8];
    d.extend_from_slice(&100_000u64.to_le_bytes());
    d.push(DECIMALS);
    let ix = Instruction::new_with_bytes(T22, &d, vec![AccountMeta::new(src, false), AccountMeta::new_readonly(env.mint, false),
        AccountMeta::new(v.ta, false), AccountMeta::new_readonly(src_owner.pubkey(), true)]);
    let payer = env.payer.insecure_clone();
    send(&mut env.svm, &payer, &[&src_owner], &[ix]).unwrap();
    let bal = balance(&env.svm, &v.ta).unwrap();
    assert_eq!(bal, 99_000);
    let dest = token_account_sized(&mut env, &Address::new_unique(), 178);
    let refund = token_account_sized(&mut env, &Address::new_unique(), 178);
    let rent_to = Address::new_unique();
    let data = spend_data(&env, &v, dest, refund, rent_to, 10_000);
    let ix = Instruction { program_id: env.prog, accounts: metas(&env, &v, dest, refund, rent_to), data: data.clone() };
    let e = send(&mut env.svm, &payer, &[&v.owner], &[cu_limit(), ix.clone()]).expect_err("close must fail with withheld fees");
    println!("spend with withheld fees fails: {}", e.lines().next().unwrap_or(""));
    // anyone harvests withheld fees to the mint, then the identical spend works
    let h = Instruction::new_with_bytes(T22, &[26u8, 4], vec![AccountMeta::new(env.mint, false), AccountMeta::new(v.ta, false)]);
    send(&mut env.svm, &payer, &[], &[h]).unwrap();
    env.svm.expire_blockhash();
    send(&mut env.svm, &payer, &[&v.owner], &[cu_limit(), ix]).unwrap();
    assert_eq!(balance(&env.svm, &v.ta), None);
}
