//! Token-2022 extension hostility tests (real Token-2022 inside LiteSVM). Prints BEHAVIOUR lines.
//! Memo-required extension intentionally not covered.
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

// ---------- extension helpers ----------

/// Mint account space: 165 (padded base) + 1 (account type) + sum(4 + ext len).
fn mint_space(ext_lens: &[usize]) -> u64 {
    if ext_lens.is_empty() { return 82; }
    (166 + ext_lens.iter().map(|l| 4 + l).sum::<usize>()) as u64
}

/// Creates a Token-2022 mint with the given extension-init instructions run before InitializeMint2.
fn setup_ext(ext_lens: &[usize], pres: Vec<Vec<u8>>, freeze: bool) -> Env {
    let mut svm = LiteSVM::new();
    let prog = Address::new_unique();
    svm.add_program_from_file(prog, concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/qc_vault.so")).unwrap();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 1_000_000_000_000).unwrap();
    let mint_kp = Keypair::new();
    create(&mut svm, &payer, &mint_kp, mint_space(ext_lens), &T22);
    let mut ixs: Vec<Instruction> = pres.iter()
        .map(|p| Instruction::new_with_bytes(T22, p, vec![AccountMeta::new(mint_kp.pubkey(), false)])).collect();
    let mut d = vec![20u8, DECIMALS];
    d.extend_from_slice(payer.pubkey().as_ref());
    if freeze { d.push(1); d.extend_from_slice(payer.pubkey().as_ref()); } else { d.push(0); }
    ixs.push(Instruction::new_with_bytes(T22, &d, vec![AccountMeta::new(mint_kp.pubkey(), false)]));
    send(&mut svm, &payer, &[], &ixs).unwrap();
    Env { svm, prog, payer, mint: mint_kp.pubkey() }
}

fn run_spend(env: &mut Env, v: &Vault, dest: Address, refund: Address, amount: u64) -> Result<u64, String> {
    let rent_to = env.payer.pubkey();
    let data = spend_data(env, v, dest, refund, rent_to, amount);
    let ix = Instruction::new_with_bytes(env.prog, &data, metas(env, v, dest, refund, rent_to));
    let payer = env.payer.insecure_clone();
    send(&mut env.svm, &payer, &[&v.owner], &[cu_limit(), ix])
}

fn tok_ix(env: &mut Env, data: Vec<u8>, metas: Vec<AccountMeta>, extra: &[&Keypair]) -> Result<u64, String> {
    let ix = Instruction::new_with_bytes(T22, &data, metas);
    let payer = env.payer.insecure_clone();
    env.svm.expire_blockhash(); // identical txs would otherwise be rejected as replays
    send(&mut env.svm, &payer, extra, &[ix])
}

fn amount_of(env: &Env, ta: &Address) -> u64 { balance(&env.svm, ta).unwrap_or(0) }
fn is_spent(env: &Env, v: &Vault) -> bool { env.svm.get_account(&v.pda).map(|a| a.owner == env.prog).unwrap_or(false) }
fn first_line(e: &str) -> String { e.lines().next().unwrap_or("").to_string() }
fn res(r: &Result<u64, String>) -> String {
    match r { Ok(_) => "ok".to_string(), Err(e) => format!("ERR {}", first_line(e)) }
}

struct Scene { env: Env, v: Vault, next: Vault, dest: Address }
fn scene(mut env: Env, fund: u64) -> Scene {
    let mut rng = Rng::from_env(22);
    let v = new_vault(&mut env, &mut rng, fund);
    let next = new_vault(&mut env, &mut rng, 0);
    let dest = ata(&mut env, &Address::new_unique());
    Scene { env, v, next, dest }
}

fn pk(a: &Address) -> &[u8] { a.as_ref() }

// ---------- 1. transfer fee ----------
#[test]
fn ext_transfer_fee() {
    // 1% fee, huge max fee.
    let auth = Address::new_unique();
    let mut d = vec![26u8, 0];
    d.push(1); d.extend_from_slice(pk(&auth));
    d.push(1); d.extend_from_slice(pk(&auth));
    d.extend_from_slice(&100u16.to_le_bytes());
    d.extend_from_slice(&u64::MAX.to_le_bytes());
    let env = setup_ext(&[108], vec![d], false);
    let mut s = scene(env, 1_000_000);
    assert_eq!(amount_of(&s.env, &s.v.ta), 1_000_000);
    let r = run_spend(&mut s.env, &s.v, s.dest, s.next.ta, 400_000);
    let got_dest = amount_of(&s.env, &s.dest);
    let got_next = amount_of(&s.env, &s.next.ta);
    println!("BEHAVIOUR transfer_fee: {} dest={} refund={} spent={}", res(&r), got_dest, got_next, is_spent(&s.env, &s.v));
    r.expect("spend with a transfer-fee mint succeeds (fee is taken from the recipients)");
    assert_eq!(got_dest, 396_000, "dest receives amount minus 1% fee");
    assert_eq!(got_next, 594_000, "refund receives rest minus 1% fee");
    assert!(is_spent(&s.env, &s.v));
    assert!(balance(&s.env.svm, &s.v.ta).is_none(), "vault token account closed");
}

// ---------- 2. permanent delegate ----------
#[test]
fn ext_permanent_delegate() {
    let delegate = Keypair::new();
    let mut d = vec![35u8];
    d.extend_from_slice(pk(&delegate.pubkey()));
    let env = setup_ext(&[32], vec![d], false);
    let mut s = scene(env, 1_000_000);
    // (a) The program itself still spends normally.
    let r = run_spend(&mut s.env, &s.v, s.dest, s.next.ta, 250_000);
    println!("BEHAVIOUR permanent_delegate/spend: {} dest={} refund={}",
        res(&r), amount_of(&s.env, &s.dest), amount_of(&s.env, &s.next.ta));
    r.unwrap();
    assert_eq!(amount_of(&s.env, &s.dest), 250_000);
    assert_eq!(amount_of(&s.env, &s.next.ta), 750_000);
    // (b) Mint-level property: the permanent delegate can move ANY holder's tokens without the
    // vault's WOTS/owner signature. A property of the mint, not of the program.
    let mut rng = Rng::from_env(23);
    let v2 = new_vault(&mut s.env, &mut rng, 500_000);
    let delegate_ta = ata(&mut s.env, &delegate.pubkey());
    let mut data = vec![12u8];
    data.extend_from_slice(&500_000u64.to_le_bytes());
    data.push(DECIMALS);
    let mint = s.env.mint;
    let r2 = tok_ix(&mut s.env, data, vec![
        AccountMeta::new(v2.ta, false), AccountMeta::new_readonly(mint, false),
        AccountMeta::new(delegate_ta, false), AccountMeta::new_readonly(delegate.pubkey(), true)], &[&delegate]);
    println!("BEHAVIOUR permanent_delegate/third-party drain of vault ATA without vault sig: {} (delegate_ta={})",
        res(&r2), amount_of(&s.env, &delegate_ta));
    assert!(r2.is_ok(), "documented mint-level capability: permanent delegate can drain any account");
    assert_eq!(amount_of(&s.env, &v2.ta), 0);
}

// ---------- 3. non-transferable mint ----------
#[test]
fn ext_non_transferable_mint() {
    let env = setup_ext(&[0], vec![vec![32u8]], false);
    let mut s = scene(env, 1_000_000);
    assert_eq!(amount_of(&s.env, &s.v.ta), 1_000_000);
    let r = run_spend(&mut s.env, &s.v, s.dest, s.next.ta, 400_000);
    println!("BEHAVIOUR non_transferable: {} vault_bal={} spent={}",
        res(&r), amount_of(&s.env, &s.v.ta), is_spent(&s.env, &s.v));
    r.expect_err("non-transferable tokens must not move");
    assert_eq!(amount_of(&s.env, &s.v.ta), 1_000_000);
    assert_eq!(amount_of(&s.env, &s.dest), 0);
    assert!(!is_spent(&s.env, &s.v));
}

// ---------- 4. default account state = frozen ----------
#[test]
fn ext_default_account_state_frozen() {
    // Freeze authority = payer so the issuer can thaw (needed to fund at all).
    let mut env = setup_ext(&[1], vec![vec![28u8, 0, 2]], true);
    let mut rng = Rng::from_env(24);
    let v = new_vault(&mut env, &mut rng, 0); // ATA is created frozen
    let next = new_vault(&mut env, &mut rng, 0);
    let dest = ata(&mut env, &Address::new_unique());
    let mint = env.mint;
    let payer_pk = env.payer.pubkey();
    let mut md = vec![14u8];
    md.extend_from_slice(&1_000_000u64.to_le_bytes());
    md.push(DECIMALS);
    let mint_metas = vec![AccountMeta::new(mint, false), AccountMeta::new(v.ta, false), AccountMeta::new_readonly(payer_pk, true)];
    let mut md_try = md.clone();
    md_try[1] = 1; // distinct tx from the real funding below (LiteSVM rejects replays)
    let r = tok_ix(&mut env, md_try, mint_metas.clone(), &[]);
    println!("BEHAVIOUR default_frozen/mint_to_frozen_vault_ta: {}", res(&r));
    assert!(r.is_err());
    let thaw = |env: &mut Env, ta: Address| {
        tok_ix(env, vec![11u8], vec![AccountMeta::new(ta, false), AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(payer_pk, true)], &[]).unwrap();
    };
    for ta in [v.ta, dest, next.ta] { thaw(&mut env, ta); }
    tok_ix(&mut env, md, mint_metas, &[]).unwrap();
    // Hostile issuer freezes the vault ta again.
    tok_ix(&mut env, vec![10u8], vec![AccountMeta::new(v.ta, false), AccountMeta::new_readonly(mint, false),
        AccountMeta::new_readonly(payer_pk, true)], &[]).unwrap();
    let mut s = Scene { env, v, next, dest };
    let r = run_spend(&mut s.env, &s.v, s.dest, s.next.ta, 400_000);
    println!("BEHAVIOUR default_frozen/spend_from_frozen_vault_ta: {} vault_bal={} spent={}",
        res(&r), amount_of(&s.env, &s.v.ta), is_spent(&s.env, &s.v));
    r.expect_err("frozen source must not spend");
    assert_eq!(amount_of(&s.env, &s.v.ta), 1_000_000);
    assert!(!is_spent(&s.env, &s.v), "revert is atomic; vault not marked spent");

    // Thaw source; a newly created (hence frozen) destination blocks the spend.
    thaw(&mut s.env, s.v.ta);
    let frozen_dest = ata(&mut s.env, &Address::new_unique());
    let r = run_spend(&mut s.env, &s.v, frozen_dest, s.next.ta, 400_000);
    println!("BEHAVIOUR default_frozen/spend_to_frozen_destination: {}", res(&r));
    r.expect_err("frozen destination must reject");
    assert_eq!(amount_of(&s.env, &s.v.ta), 1_000_000);
    assert!(!is_spent(&s.env, &s.v));
    // All thawed -> normal spend works.
    let r = run_spend(&mut s.env, &s.v, s.dest, s.next.ta, 400_000);
    println!("BEHAVIOUR default_frozen/spend_all_thawed: {}", res(&r));
    r.unwrap();
    assert_eq!(amount_of(&s.env, &s.dest), 400_000);
    assert_eq!(amount_of(&s.env, &s.next.ta), 600_000);
}

// ---------- 5. transfer hook ----------
fn hook_env(hook_prog: Address) -> Env {
    let mut d = vec![36u8, 0];
    d.extend_from_slice(pk(&Address::new_unique())); // hook authority
    d.extend_from_slice(pk(&hook_prog));
    setup_ext(&[64], vec![d], false)
}

#[test]
fn ext_transfer_hook_undeployed_program() {
    let mut s = scene(hook_env(Address::new_unique()), 1_000_000);
    let r = run_spend(&mut s.env, &s.v, s.dest, s.next.ta, 400_000);
    println!("BEHAVIOUR transfer_hook(undeployed program): {} vault_bal={} spent={}",
        res(&r), amount_of(&s.env, &s.v.ta), is_spent(&s.env, &s.v));
    r.expect_err("the vault CPI passes no hook accounts, so the transfer cannot proceed");
    assert_eq!(amount_of(&s.env, &s.v.ta), 1_000_000);
    assert!(!is_spent(&s.env, &s.v));
}

#[test]
fn ext_transfer_hook_existing_program() {
    // Hook points at an executable that exists (ComputeBudget builtin); still no extra accounts passed.
    let mut s = scene(hook_env(CB), 1_000_000);
    let r = run_spend(&mut s.env, &s.v, s.dest, s.next.ta, 400_000);
    println!("BEHAVIOUR transfer_hook(existing program, no extra accounts): {} vault_bal={} spent={}",
        res(&r), amount_of(&s.env, &s.v.ta), is_spent(&s.env, &s.v));
    r.expect_err("hook program account is not supplied by the vault CPI");
    assert_eq!(amount_of(&s.env, &s.v.ta), 1_000_000);
    assert!(!is_spent(&s.env, &s.v));
}

// ---------- 6. vault token account with close authority / delegate set by someone else ----------
#[test]
fn vault_ta_third_party_authority_attempts_rejected_by_token_program() {
    let mut env = setup_ext(&[], vec![], false);
    let mut rng = Rng::from_env(25);
    let v = new_vault(&mut env, &mut rng, 1_000_000);
    let attacker = Keypair::new();
    // SetAuthority(CloseAccount=3) by attacker
    let mut d = vec![6u8, 3, 1];
    d.extend_from_slice(pk(&attacker.pubkey()));
    let r1 = tok_ix(&mut env, d, vec![AccountMeta::new(v.ta, false), AccountMeta::new_readonly(attacker.pubkey(), true)], &[&attacker]);
    // Approve delegate by attacker
    let mut d = vec![4u8];
    d.extend_from_slice(&1_000_000u64.to_le_bytes());
    let r2 = tok_ix(&mut env, d, vec![AccountMeta::new(v.ta, false), AccountMeta::new_readonly(attacker.pubkey(), false),
        AccountMeta::new_readonly(attacker.pubkey(), true)], &[&attacker]);
    println!("BEHAVIOUR vault_ta/third-party set close-authority: {}; approve delegate: {}", res(&r1), res(&r2));
    r1.expect_err("only the owner (vault PDA, no key) can set the close authority");
    r2.expect_err("only the owner can approve a delegate");
    let acc = env.svm.get_account(&v.ta).unwrap();
    assert_eq!(&acc.data[72..76], &[0, 0, 0, 0], "no delegate");
    assert_eq!(&acc.data[129..133], &[0, 0, 0, 0], "no close authority");
}

/// Hypothetical (not reachable on chain; forced with set_account): if a vault ATA ever carried a
/// third-party close authority or delegate, how does the program behave?
#[test]
fn vault_ta_injected_close_authority_and_delegate() {
    // (a) close authority = third party
    {
        let mut s = scene(setup_ext(&[], vec![], false), 1_000_000);
        let mut acc = s.env.svm.get_account(&s.v.ta).unwrap();
        acc.data[129..133].copy_from_slice(&[1, 0, 0, 0]);
        acc.data[133..165].copy_from_slice(pk(&Address::new_unique()));
        s.env.svm.set_account(s.v.ta, acc).unwrap();
        let r = run_spend(&mut s.env, &s.v, s.dest, s.next.ta, 400_000);
        println!("BEHAVIOUR injected close_authority=third party: {} vault_bal={} spent={}",
            res(&r), amount_of(&s.env, &s.v.ta), is_spent(&s.env, &s.v));
        r.expect_err("CloseAccount needs the close authority's signature; vault PDA is not it");
        assert_eq!(amount_of(&s.env, &s.v.ta), 1_000_000, "atomic revert, funds not moved");
        assert_eq!(amount_of(&s.env, &s.dest), 0);
        assert!(!is_spent(&s.env, &s.v));
    }
    // (b) delegate = third party with an allowance
    {
        let mut s = scene(setup_ext(&[], vec![], false), 1_000_000);
        let mut acc = s.env.svm.get_account(&s.v.ta).unwrap();
        acc.data[72..76].copy_from_slice(&[1, 0, 0, 0]);
        acc.data[76..108].copy_from_slice(pk(&Address::new_unique()));
        acc.data[121..129].copy_from_slice(&1_000_000u64.to_le_bytes());
        s.env.svm.set_account(s.v.ta, acc).unwrap();
        let r = run_spend(&mut s.env, &s.v, s.dest, s.next.ta, 400_000);
        println!("BEHAVIOUR injected delegate=third party: {} dest={} refund={} spent={}",
            res(&r), amount_of(&s.env, &s.dest), amount_of(&s.env, &s.next.ta), is_spent(&s.env, &s.v));
        r.unwrap();
        assert_eq!(amount_of(&s.env, &s.dest), 400_000);
        assert_eq!(amount_of(&s.env, &s.next.ta), 600_000);
        assert!(is_spent(&s.env, &s.v));
    }
}
