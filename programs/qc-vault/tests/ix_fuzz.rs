//! Seeded raw-instruction fuzz. QC_FUZZ_SEED / QC_FUZZ_CASES override seed and counts.
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
const ATA: Address = Address::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/// `owner`'s Token-2022 associated token account, made by the ATA program
/// (which sizes it for the mint's extensions). Vaults must hold funds here.
fn ata(env: &mut Env, owner: &Address) -> Address {
    let (a, _) = Address::find_program_address(&[owner.as_ref(), T22.as_ref(), env.mint.as_ref()], &ATA);
    let ix = Instruction::new_with_bytes(ATA, &[1], vec![ // CreateIdempotent
        AccountMeta::new(env.payer.pubkey(), true), AccountMeta::new(a, false),
        AccountMeta::new_readonly(*owner, false), AccountMeta::new_readonly(env.mint, false),
        AccountMeta::new_readonly(Address::default(), false), AccountMeta::new_readonly(T22, false)]);
    let payer = env.payer.insecure_clone();
    send(&mut env.svm, &payer, &[], &[ix]).unwrap();
    a
}
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
fn new_vault(env: &mut Env, rng: &mut Rng, fund: u64) -> Vault {
    let master: [u8; 32] = rng.arr();
    let seed: [u8; 16] = rng.arr();
    let owner = Keypair::new();
    let pk = wots::keys::public_key_hash(&master, &seed);
    let (pda, bump) = Address::find_program_address(&[VAULT_SEED, &pk, owner.pubkey().as_ref()], &env.prog);
    let ta = ata(env, &pda);
    if fund > 0 { mint_to(env, ta, fund); }
    Vault { master, seed, owner, pda, bump, ta }
}
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

// ---------- raw-instruction fuzz ----------
const GOOD_LEN: usize = 650;

struct Fx { env: Env, v: Vault, next: Vault, dest: Address, rent_to: Address, good: Vec<u8>, serial: u32 }

fn fixture() -> Fx {
    let mut env = setup();
    let mut rng = Rng::from_env(0x1234);
    let v = new_vault(&mut env, &mut rng, 1_000_000);
    let next = new_vault(&mut env, &mut rng, 0);
    let dest = ata(&mut env, &Address::new_unique());
    let rent_to = env.payer.pubkey();
    let good = spend_data(&env, &v, dest, next.ta, rent_to, 400_000);
    assert_eq!(good.len(), GOOD_LEN);
    Fx { env, v, next, dest, rent_to, good, serial: 0 }
}


fn make_tx(fx: &Fx, ixs: &[Instruction]) -> Transaction {
    let payer = fx.env.payer.insecure_clone();
    let owner = fx.v.owner.insecure_clone();
    let msg = Message::new(ixs, Some(&payer.pubkey()));
    let n = msg.header.num_required_signatures as usize;
    let mut signers: Vec<&Keypair> = vec![&payer];
    if msg.account_keys[..n].contains(&owner.pubkey()) { signers.push(&owner); }
    Transaction::new(&signers, msg, fx.env.svm.latest_blockhash())
}

/// Sends one raw instruction. Returns Err(first log/err line) classification input.
/// Asserts: never succeeds, and fails with a clean program error code 1..=8.
fn must_fail_clean(fx: &mut Fx, data: &[u8], metas: Vec<AccountMeta>, what: &str, tally: &mut std::collections::BTreeMap<String, u32>) {
    fx.serial += 1;
    // Vary the message so LiteSVM never dedups two identical transactions.
    let mut cu = vec![2u8];
    cu.extend_from_slice(&(1_400_000u32 - fx.serial).to_le_bytes());
    let cu_ix = Instruction::new_with_bytes(CB, &cu, vec![]);
    let ix = Instruction::new_with_bytes(fx.env.prog, data, metas);
    let tx = make_tx(fx, &[cu_ix, ix]);
    match fx.env.svm.send_transaction(tx) {
        Ok(_) => panic!("MALFORMED INPUT SUCCEEDED [{what}] len={} data[..8]={:02x?}", data.len(), &data[..data.len().min(8)]),
        Err(e) => {
            let s = format!("{:?}", e.err);
            // clean = the program returned Custom(1..=8); anything else (panic, access violation,
            // budget exceeded, unsupported sysvar...) is not clean.
            let code = (1..=8u32).find(|c| s.contains(&format!("Custom({c})")));
            assert!(code.is_some(), "NON-CLEAN FAILURE [{what}] len={} err={s}\n{}", data.len(), e.meta.logs.join("\n"));
            assert!(!e.meta.logs.iter().any(|l| l.contains("panicked")), "panic logged [{what}]");
            *tally.entry(format!("Custom({})", code.unwrap())).or_default() += 1;
        }
    }
}

fn good_metas(fx: &Fx) -> Vec<AccountMeta> { metas(&fx.env, &fx.v, fx.dest, fx.next.ta, fx.rent_to) }

fn assert_untouched(fx: &Fx) {
    assert_eq!(balance(&fx.env.svm, &fx.v.ta), Some(1_000_000), "vault balance changed");
    assert_ne!(fx.env.svm.get_account(&fx.v.pda).map(|a| a.owner), Some(fx.env.prog), "vault marked spent");
    assert_eq!(balance(&fx.env.svm, &fx.dest), Some(0));
}

fn report(name: &str, n: usize, tally: &std::collections::BTreeMap<String, u32>) {
    println!("IXFUZZ {name}: cases={n} outcomes={tally:?}");
}

#[test]
fn ixfuzz_00_baseline_valid_spend_works_on_fresh_fixture() {
    // Guards the fuzz harness itself: the unmutated payload is accepted (so every mutation is meaningful).
    let mut fx = fixture();
    let ix = Instruction::new_with_bytes(fx.env.prog, &fx.good, good_metas(&fx));
    let payer = fx.env.payer.insecure_clone();
    let owner = fx.v.owner.insecure_clone();
    send(&mut fx.env.svm, &payer, &[&owner], &[cu_limit(), ix]).unwrap();
    assert_eq!(balance(&fx.env.svm, &fx.dest), Some(400_000));
}

#[test]
fn ixfuzz_01_random_lengths_and_content() {
    let mut fx = fixture();
    let mut rng = Rng::from_env(1);
    let mut tally = Default::default();
    let n = cases(1500);
    for i in 0..n {
        // 0..1300 inclusive; every 7th case keeps the exact 650 length with random bytes.
        let len = if i % 7 == 0 { GOOD_LEN } else { rng.below(1301) as usize };
        let mut d = vec![0u8; len];
        rng.fill(&mut d);
        if i % 3 == 0 && len > 0 { d[0] = 0; } // valid discriminator, garbage rest
        let m = good_metas(&fx);
        must_fail_clean(&mut fx, &d, m, "random-len", &mut tally);
    }
    assert_untouched(&fx);
    report("random_lengths", n, &tally);
}

#[test]
fn ixfuzz_02_truncated_and_extended_valid_payloads() {
    let mut fx = fixture();
    let mut rng = Rng::from_env(2);
    let mut tally = Default::default();
    let mut n = 0;
    // Exhaustive truncations 0..650 and extensions by 1..=650 bytes of zeros, then random extras.
    for cut in 0..GOOD_LEN {
        let m = good_metas(&fx);
        let g = fx.good[..cut].to_vec();
        must_fail_clean(&mut fx, &g, m, "truncate", &mut tally);
        n += 1;
    }
    for extra in 1..=GOOD_LEN {
        let mut d = fx.good.clone();
        d.extend(std::iter::repeat(0u8).take(extra));
        let m = good_metas(&fx);
        must_fail_clean(&mut fx, &d, m, "extend-zero", &mut tally);
        n += 1;
    }
    for _ in 0..cases(300) {
        let mut d = fx.good.clone();
        let extra = 1 + rng.below(650) as usize;
        let mut tail = vec![0u8; extra];
        rng.fill(&mut tail);
        d.extend_from_slice(&tail);
        let m = good_metas(&fx);
        must_fail_clean(&mut fx, &d, m, "extend-random", &mut tally);
        n += 1;
    }
    assert_untouched(&fx);
    report("truncate_extend", n, &tally);
}

#[test]
fn ixfuzz_03_random_discriminator_bytes() {
    let mut fx = fixture();
    let mut tally = Default::default();
    let mut n = 0;
    // Every non-zero discriminator value, correct length and otherwise valid payload.
    for disc in 1..=255u8 {
        let mut d = fx.good.clone();
        d[0] = disc;
        let m = good_metas(&fx);
        must_fail_clean(&mut fx, &d, m, "discriminator", &mut tally);
        n += 1;
    }
    // Random discriminators with random lengths 1..1300 / random bodies.
    let mut rng = Rng::from_env(3);
    for _ in 0..cases(600) {
        let len = 1 + rng.below(1300) as usize;
        let mut d = vec![0u8; len];
        rng.fill(&mut d);
        if d[0] == 0 { d[0] = 1 + (rng.below(255) as u8); }
        let m = good_metas(&fx);
        must_fail_clean(&mut fx, &d, m, "random-disc", &mut tally);
        n += 1;
    }
    assert_untouched(&fx);
    report("discriminator", n, &tally);
}

#[test]
fn ixfuzz_04_bit_flips_in_every_region() {
    let mut fx = fixture();
    let mut rng = Rng::from_env(4);
    let mut tally = Default::default();
    // Regions: disc [0], bump [1], seed [2..18], amount [18..26], signature [26..650].
    let regions: [(&str, usize, usize); 5] =
        [("disc", 0, 1), ("bump", 1, 2), ("seed", 2, 18), ("amount", 18, 26), ("sig", 26, 650)];
    let mut n = 0;
    // (a) Exhaustive single-bit flips over the first 26 header bytes (208 flips).
    for byte in 0..26 {
        for bit in 0..8 {
            let mut d = fx.good.clone();
            d[byte] ^= 1 << bit;
            let m = good_metas(&fx);
            must_fail_clean(&mut fx, &d, m, "flip-header", &mut tally);
            n += 1;
        }
    }
    // (b) Random 1..=8-bit flips per region.
    for _ in 0..cases(120) {
        for (name, lo, hi) in regions {
            let mut d = fx.good.clone();
            for _ in 0..1 + rng.below(8) {
                let byte = lo + rng.below((hi - lo) as u64) as usize;
                d[byte] ^= 1 << rng.below(8);
            }
            if d == fx.good { continue; }
            let m = good_metas(&fx);
            must_fail_clean(&mut fx, &d, m, name, &mut tally);
            n += 1;
        }
    }
    // (c) Whole-region randomisation.
    for (name, lo, hi) in regions {
        for _ in 0..cases(20) {
            let mut d = fx.good.clone();
            rng.fill(&mut d[lo..hi]);
            if d == fx.good { continue; }
            let m = good_metas(&fx);
            must_fail_clean(&mut fx, &d, m, name, &mut tally);
            n += 1;
        }
    }
    assert_untouched(&fx);
    report("bit_flips", n, &tally);
}

#[test]
fn ixfuzz_05_wrong_account_counts() {
    let mut fx = fixture();
    let mut rng = Rng::from_env(5);
    let mut tally = Default::default();
    let mut n = 0;
    for count in 0..=12usize {
        if count == 9 { continue; }
        // Valid payload with 0..=12 accounts (extra accounts are distinct fresh addresses; fewer = prefix).
        for rep in 0..cases(80) {
            let mut m = good_metas(&fx);
            m.truncate(count.min(9));
            while m.len() < count { m.push(AccountMeta::new_readonly(Address::new_unique(), false)); }
            let data = if rep % 4 == 0 {
                // random payload of random length with this count
                let len = rng.below(1301) as usize;
                let mut d = vec![0u8; len];
                rng.fill(&mut d);
                d
            } else { fx.good.clone() };
            must_fail_clean(&mut fx, &data, m, "acct-count", &mut tally);
            n += 1;
        }
    }
    // Right count (9), but with duplicated accounts -> clean refusal as well.
    for i in 0..9 {
        for j in 0..9 {
            if i == j { continue; }
            let mut m = good_metas(&fx);
            let dup = m[i].clone();
            m[j] = AccountMeta { pubkey: dup.pubkey, is_signer: dup.is_signer, is_writable: dup.is_writable };
            let g = fx.good.clone();
            must_fail_clean_any(&mut fx, &g, m, &mut tally);
            n += 1;
        }
    }
    assert_untouched(&fx);
    report("account_counts", n, &tally);
}

/// Like must_fail_clean, but also tolerates runtime-level rejections that happen before the
/// program runs (e.g. a signer flag mismatch on duplicated keys) -- they are still clean failures.
fn must_fail_clean_any(fx: &mut Fx, data: &[u8], metas: Vec<AccountMeta>, tally: &mut std::collections::BTreeMap<String, u32>) {
    fx.serial += 1;
    let mut cu = vec![2u8];
    cu.extend_from_slice(&(1_400_000u32 - fx.serial).to_le_bytes());
    let cu_ix = Instruction::new_with_bytes(CB, &cu, vec![]);
    let ix = Instruction::new_with_bytes(fx.env.prog, data, metas);
    let tx = make_tx(fx, &[cu_ix, ix]);
    match fx.env.svm.send_transaction(tx) {
        Ok(_) => panic!("duplicate-account variant SUCCEEDED"),
        Err(e) => {
            let s = format!("{:?}", e.err);
            assert!(!e.meta.logs.iter().any(|l| l.contains("panicked")));
            assert!(s.contains("Custom(") || s.contains("InstructionError") || s.contains("Sanitize") || s.contains("Account"),
                "unexpected failure kind: {s}");
            assert!(!s.contains("ComputationalBudgetExceeded") && !s.contains("ProgramFailedToComplete"), "non-clean: {s}");
            let k = if let Some(i) = s.find("Custom(") { s[i..].split(')').next().unwrap().to_string() + ")" } else { "runtime-reject".into() };
            *tally.entry(k).or_default() += 1;
        }
    }
}
