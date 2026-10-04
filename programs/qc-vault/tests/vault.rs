//! End-to-end tests against the real Token-2022 program inside LiteSVM.
//! Build the program first: `cargo build-sbf`.
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
const ATA: Address = Address::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const DECIMALS: u8 = 5;
const SUPPLY: u64 = 22_000_000_000_000 * 100_000; // 22T QC at 5 decimals

struct Env {
    svm: LiteSVM,
    prog: Address,
    payer: Keypair,
    mint: Address,
}

struct Vault {
    master: [u8; 32],
    seed: [u8; 16],
    owner: Keypair,
    pda: Address,
    bump: u8,
    ta: Address,
}

fn send(svm: &mut LiteSVM, payer: &Keypair, extra: &[&Keypair], ixs: &[Instruction]) -> Result<u64, String> {
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra);
    let tx = Transaction::new(&signers, Message::new(ixs, Some(&payer.pubkey())), svm.latest_blockhash());
    svm.send_transaction(tx)
        .map(|m| m.compute_units_consumed)
        .map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")))
}

fn create(svm: &mut LiteSVM, payer: &Keypair, kp: &Keypair, space: u64, owner: &Address) {
    let lamports = svm.minimum_balance_for_rent_exemption(space as usize);
    let ix = solana_system_interface::instruction::create_account(&payer.pubkey(), &kp.pubkey(), lamports, space, owner);
    send(svm, payer, &[kp], &[ix]).unwrap();
}

fn token_account(env: &mut Env, owner: &Address) -> Address {
    let kp = Keypair::new();
    create(&mut env.svm, &env.payer, &kp, 165, &T22);
    let mut d = vec![18u8]; // InitializeAccount3
    d.extend_from_slice(owner.as_ref());
    let ix = Instruction::new_with_bytes(
        T22,
        &d,
        vec![AccountMeta::new(kp.pubkey(), false), AccountMeta::new_readonly(env.mint, false)],
    );
    let payer = env.payer.insecure_clone();
    send(&mut env.svm, &payer, &[], &[ix]).unwrap();
    kp.pubkey()
}

fn balance(svm: &LiteSVM, ta: &Address) -> Option<u64> {
    svm.get_account(ta)
        .filter(|a| a.lamports > 0)
        .map(|a| u64::from_le_bytes(a.data[64..72].try_into().unwrap()))
}

fn rand_bytes<const L: usize>() -> [u8; L] {
    let k = Keypair::new().to_bytes();
    let mut o = [0u8; L];
    o.copy_from_slice(&k[..L]);
    o
}

fn setup() -> Env {
    let mut svm = LiteSVM::new();
    let prog = Address::new_unique();
    svm.add_program_from_file(prog, concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/qc_vault.so"))
        .unwrap();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
    let mint_kp = Keypair::new();
    create(&mut svm, &payer, &mint_kp, 82, &T22);
    let mut d = vec![20u8, DECIMALS]; // InitializeMint2, no freeze authority
    d.extend_from_slice(payer.pubkey().as_ref());
    d.push(0);
    let ix = Instruction::new_with_bytes(T22, &d, vec![AccountMeta::new(mint_kp.pubkey(), false)]);
    send(&mut svm, &payer, &[], &[ix]).unwrap();
    Env { svm, prog, payer, mint: mint_kp.pubkey() }
}

fn new_vault(env: &mut Env, fund: u64) -> Vault {
    let master: [u8; 32] = rand_bytes();
    let seed: [u8; 16] = rand_bytes();
    let owner = Keypair::new();
    let pk = wots::keys::public_key_hash(&master, &seed);
    let (pda, bump) = Address::find_program_address(&[VAULT_SEED, &pk, owner.pubkey().as_ref()], &env.prog);
    // The program only drains the PDA's associated token account.
    let (ta, _) = Address::find_program_address(&[pda.as_ref(), T22.as_ref(), env.mint.as_ref()], &ATA);
    let ix = Instruction::new_with_bytes(ATA, &[1], vec![ // CreateIdempotent
        AccountMeta::new(env.payer.pubkey(), true), AccountMeta::new(ta, false),
        AccountMeta::new_readonly(pda, false), AccountMeta::new_readonly(env.mint, false),
        AccountMeta::new_readonly(Address::default(), false), AccountMeta::new_readonly(T22, false)]);
    let payer = env.payer.insecure_clone();
    send(&mut env.svm, &payer, &[], &[ix]).unwrap();
    if fund > 0 {
        let mut d = vec![14u8]; // MintToChecked
        d.extend_from_slice(&fund.to_le_bytes());
        d.push(DECIMALS);
        let ix = Instruction::new_with_bytes(
            T22,
            &d,
            vec![
                AccountMeta::new(env.mint, false),
                AccountMeta::new(ta, false),
                AccountMeta::new_readonly(env.payer.pubkey(), true),
            ],
        );
        let payer = env.payer.insecure_clone();
        send(&mut env.svm, &payer, &[], &[ix]).unwrap();
    }
    Vault { master, seed, owner, pda, bump, ta }
}

/// Builds a Spend that sends `amount` but signs `signed_amount`.
fn spend_ix(env: &Env, v: &Vault, dest: Address, refund: Address, rent_to: Address, amount: u64, signed_amount: u64) -> Instruction {
    let digest = spend_digest(
        env.prog.as_array(),
        v.pda.as_array(),
        env.mint.as_array(),
        dest.as_array(),
        refund.as_array(),
        rent_to.as_array(),
        signed_amount,
    );
    let sig = wots::keys::sign(&v.master, &v.seed, &digest);
    let mut d = vec![0u8, v.bump];
    d.extend_from_slice(&v.seed);
    d.extend_from_slice(&amount.to_le_bytes());
    d.extend_from_slice(&sig);
    Instruction::new_with_bytes(
        env.prog,
        &d,
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
        ],
    )
}

/// Asserts the transaction failed with our program's custom error `code`,
/// not for some unrelated reason (e.g. duplicate accounts).
fn expect_err(r: Result<u64, String>, code: u32) {
    let e = r.expect_err("transaction must fail");
    assert!(e.contains(&format!("Custom({code})")), "expected Custom({code}), got:
{e}");
}

fn cu_limit() -> Instruction {
    let mut d = vec![2u8];
    d.extend_from_slice(&1_400_000u32.to_le_bytes());
    Instruction::new_with_bytes(CB, &d, vec![])
}

#[test]
fn wots_roundtrip_and_tamper() {
    let m = [7u8; 32];
    let seed = [9u8; 16];
    let digest = [0x5au8; 24];
    let sig = wots::keys::sign(&m, &seed, &digest);
    let pk = wots::keys::public_key_hash(&m, &seed);
    assert_eq!(wots::recover_pk_hash(&seed, &digest, &sig), pk);
    let mut other = digest;
    other[0] ^= 1;
    assert_ne!(wots::recover_pk_hash(&seed, &other, &sig), pk);
}

#[test]
fn genesis_supply_spend_and_rotate() {
    let mut env = setup();
    let v = new_vault(&mut env, SUPPLY);
    let next = new_vault(&mut env, 0);
    let dest = token_account(&mut env, &Address::new_unique());
    let rent_to = env.payer.pubkey();
    let amount = 1_000_000 * 100_000;
    let ix = spend_ix(&env, &v, dest, next.ta, rent_to, amount, amount);
    let payer = env.payer.insecure_clone();
    let cu = send(&mut env.svm, &payer, &[&v.owner], &[cu_limit(), ix]).unwrap();
    // Worst case: every message digit 0 → 6120 + (255-23) + (255-232) = 6375 hash steps.
    let digest = spend_digest(env.prog.as_array(), v.pda.as_array(), env.mint.as_array(), dest.as_array(),
        next.ta.as_array(), rent_to.as_array(), amount);
    let steps: u64 = wots::digits(&digest).iter().map(|d| 255 - *d as u64).sum();
    let per_step = cu as f64 / steps as f64;
    let worst = (per_step * 6375.0) as u64;
    println!("spend compute units: {cu} for {steps} hash steps; projected worst case {worst}");
    assert!(worst < 1_400_000, "worst-case spend must fit the 1.4M CU cap");
    assert_eq!(balance(&env.svm, &dest), Some(amount));
    assert_eq!(balance(&env.svm, &next.ta), Some(SUPPLY - amount));
    assert_eq!(balance(&env.svm, &v.ta), None, "spent vault token account is closed");
}

/// The spent marker keeps exactly the network's rent-exempt minimum for 0 bytes
/// and everything above it goes to rent_to, so a brand-new rent receiver always
/// ends up rent-exempt, at any rent. Mainnet rent on 2026-10-02 is 5,080
/// lamports/byte at threshold 1.0: the old hard-coded 890,880 marker left a fresh
/// receiver 622,960 lamports, below the 650,240 it needs, and the spend failed.
/// An exemption threshold the program cannot evaluate without floats leaves
/// everything in the marker (always rent-exempt) and rent_to untouched.
#[test]
fn spends_to_fresh_rent_receiver_at_any_rent() {
    for (per_byte, threshold) in [
        (5_080u64, 1.0f64), // mainnet and devnet today
        (6_960, 1.0),       // SDK default
        (3_480, 2.0),       // pre-SIMD-0194 layout
        (1, 1.0),
        (2_000, 1.0),
        (4_000, 1.0),
        (5_240, 1.0),
        (50_000, 1.0),
        (5_080, 1.5),       // threshold the program does not evaluate
    ] {
        let mut env = setup();
        #[allow(deprecated)]
        env.svm.set_sysvar(&solana_rent::Rent {
            lamports_per_byte: per_byte,
            exemption_threshold: threshold.to_le_bytes(),
            burn_percent: 50,
        });
        let v = new_vault(&mut env, 1_000);
        let dest = token_account(&mut env, &Address::new_unique());
        let refund = token_account(&mut env, &Address::new_unique());
        let rent_to = Address::new_unique();
        let closed_rent = env.svm.get_account(&v.ta).unwrap().lamports;
        let ix = spend_ix(&env, &v, dest, refund, rent_to, 400, 400);
        let payer = env.payer.insecure_clone();
        send(&mut env.svm, &payer, &[&v.owner], &[cu_limit(), ix])
            .unwrap_or_else(|e| panic!("rent {per_byte} x {threshold}: spend failed\n{e}"));
        let marker = env.svm.get_account(&v.pda).unwrap();
        let known = threshold == 1.0 || threshold == 2.0;
        let keep = if known { env.svm.minimum_balance_for_rent_exemption(0) } else { closed_rent };
        assert_eq!(marker.owner, env.prog, "rent {per_byte} x {threshold}: vault not marked spent");
        assert_eq!(marker.lamports, keep, "rent {per_byte} x {threshold}: marker lamports");
        assert_eq!(env.svm.get_account(&rent_to).map_or(0, |a| a.lamports), closed_rent - keep,
            "rent {per_byte} x {threshold}: rent_to lamports");
        assert_eq!(balance(&env.svm, &dest), Some(400));
        assert_eq!(balance(&env.svm, &refund), Some(600));
    }
}

#[test]
fn rejects_missing_owner_signature() {
    let mut env = setup();
    let v = new_vault(&mut env, 1000);
    let dest = token_account(&mut env, &Address::new_unique());
    let refund = token_account(&mut env, &Address::new_unique());
    let mut ix = spend_ix(&env, &v, dest, refund, env.payer.pubkey(), 1000, 1000);
    ix.accounts[7].is_signer = false; // relayer holds only the WOTS signature
    let payer = env.payer.insecure_clone();
    expect_err(send(&mut env.svm, &payer, &[], &[cu_limit(), ix]), 7);
    assert_eq!(balance(&env.svm, &v.ta), Some(1000));
}

#[test]
fn rejects_wrong_owner() {
    let mut env = setup();
    let v = new_vault(&mut env, 1000);
    let dest = token_account(&mut env, &Address::new_unique());
    let refund = token_account(&mut env, &Address::new_unique());
    let mut ix = spend_ix(&env, &v, dest, refund, env.payer.pubkey(), 1000, 1000);
    let thief = Keypair::new();
    ix.accounts[7].pubkey = thief.pubkey();
    let payer = env.payer.insecure_clone();
    expect_err(send(&mut env.svm, &payer, &[&thief], &[cu_limit(), ix]), 2);
    assert_eq!(balance(&env.svm, &v.ta), Some(1000));
}

#[test]
fn rejects_redirected_destination() {
    let mut env = setup();
    let v = new_vault(&mut env, 1000);
    let dest = token_account(&mut env, &Address::new_unique());
    let evil = token_account(&mut env, &Address::new_unique());
    let refund = token_account(&mut env, &Address::new_unique());
    let mut ix = spend_ix(&env, &v, dest, refund, env.payer.pubkey(), 1000, 1000);
    ix.accounts[3].pubkey = evil;
    let payer = env.payer.insecure_clone();
    expect_err(send(&mut env.svm, &payer, &[&v.owner], &[cu_limit(), ix]), 2);
    assert_eq!(balance(&env.svm, &evil), Some(0));
}

#[test]
fn rejects_changed_amount() {
    let mut env = setup();
    let v = new_vault(&mut env, 1000);
    let dest = token_account(&mut env, &Address::new_unique());
    let refund = token_account(&mut env, &Address::new_unique());
    let ix = spend_ix(&env, &v, dest, refund, env.payer.pubkey(), 900, 100);
    let payer = env.payer.insecure_clone();
    expect_err(send(&mut env.svm, &payer, &[&v.owner], &[cu_limit(), ix]), 2);
    assert_eq!(balance(&env.svm, &v.ta), Some(1000));
}

#[test]
fn rejects_overspend() {
    let mut env = setup();
    let v = new_vault(&mut env, 1000);
    let dest = token_account(&mut env, &Address::new_unique());
    let refund = token_account(&mut env, &Address::new_unique());
    let ix = spend_ix(&env, &v, dest, refund, env.payer.pubkey(), 1001, 1001);
    let payer = env.payer.insecure_clone();
    expect_err(send(&mut env.svm, &payer, &[&v.owner], &[cu_limit(), ix]), 3);
}

#[test]
fn spend_fits_one_packet() {
    let mut env = setup();
    let v = new_vault(&mut env, 1);
    let dest = token_account(&mut env, &Address::new_unique());
    let ix = spend_ix(&env, &v, dest, dest, env.payer.pubkey(), 1, 1);
    let tx = Transaction::new(
        &[&env.payer, &v.owner],
        Message::new(&[cu_limit(), ix], Some(&env.payer.pubkey())),
        env.svm.latest_blockhash(),
    );
    let size = 1 + 64 * tx.signatures.len() + tx.message.serialize().len();
    println!("spend tx size: {size} bytes (limit 1232)");
    assert!(size <= 1232);
}

#[test]
fn rejects_duplicate_accounts() {
    let mut env = setup();
    let v = new_vault(&mut env, 1000);
    let dest = token_account(&mut env, &Address::new_unique());
    let ix = spend_ix(&env, &v, dest, dest, env.payer.pubkey(), 1000, 1000);
    let payer = env.payer.insecure_clone();
    expect_err(send(&mut env.svm, &payer, &[&v.owner], &[cu_limit(), ix]), 6);
}

#[test]
fn rejects_wrong_token_program() {
    let mut env = setup();
    let v = new_vault(&mut env, 1000);
    let dest = token_account(&mut env, &Address::new_unique());
    let refund = token_account(&mut env, &Address::new_unique());
    let mut ix = spend_ix(&env, &v, dest, refund, env.payer.pubkey(), 1000, 1000);
    // A fake "token program" would sign nothing real, but must still be refused.
    ix.accounts[6].pubkey = Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    let payer = env.payer.insecure_clone();
    expect_err(send(&mut env.svm, &payer, &[&v.owner], &[cu_limit(), ix]), 5);
}

#[test]
fn rejects_replay_after_spend() {
    let mut env = setup();
    let v = new_vault(&mut env, 1000);
    let dest = token_account(&mut env, &Address::new_unique());
    let refund = token_account(&mut env, &Address::new_unique());
    let ix = spend_ix(&env, &v, dest, refund, env.payer.pubkey(), 400, 400);
    let payer = env.payer.insecure_clone();
    send(&mut env.svm, &payer, &[&v.owner], &[cu_limit(), ix.clone()]).unwrap();
    env.svm.expire_blockhash();
    // Same signed message again: the vault token account is closed, nothing moves.
    assert!(send(&mut env.svm, &payer, &[&v.owner], &[cu_limit(), ix]).is_err());
    assert_eq!(balance(&env.svm, &dest), Some(400));
    assert_eq!(balance(&env.svm, &refund), Some(600));
}

#[test]
fn rejects_tampered_signature_and_seed() {
    let mut env = setup();
    let v = new_vault(&mut env, 1000);
    let dest = token_account(&mut env, &Address::new_unique());
    let refund = token_account(&mut env, &Address::new_unique());
    let payer = env.payer.insecure_clone();
    for at in [2usize, 17, 26, 26 + 24 * 25, 649] {
        let mut ix = spend_ix(&env, &v, dest, refund, env.payer.pubkey(), 1000, 1000);
        ix.data[at] ^= 1;
        env.svm.expire_blockhash();
        expect_err(send(&mut env.svm, &payer, &[&v.owner], &[cu_limit(), ix]), 2);
    }
    let mut ix = spend_ix(&env, &v, dest, refund, env.payer.pubkey(), 1000, 1000);
    ix.data.pop();
    expect_err(send(&mut env.svm, &payer, &[&v.owner], &[cu_limit(), ix]), 1);
    assert_eq!(balance(&env.svm, &v.ta), Some(1000));
}

/// The spent marker is per vault address, so a non-canonical bump would give
/// the same WOTS key a second vault and let it sign twice. Only the canonical
/// bump is accepted.
#[test]
fn rejects_noncanonical_bump_wots_key_reuse() {
    let mut env = setup();
    let v = new_vault(&mut env, 1000); // canonical bump
    let pk = wots::keys::public_key_hash(&v.master, &v.seed);
    // Find the next valid (non-canonical) bump below the canonical one.
    let (alt_pda, alt_bump) = (0..v.bump).rev().find_map(|b| {
        Address::create_program_address(&[VAULT_SEED, &pk, v.owner.pubkey().as_ref(), &[b]], &env.prog)
            .ok().map(|a| (a, b))
    }).expect("a non-canonical bump exists");
    assert_ne!(alt_pda, v.pda);
    let (alt_ta, _) = Address::find_program_address(&[alt_pda.as_ref(), T22.as_ref(), env.mint.as_ref()], &ATA);
    // Fund the alternative vault's ATA (anyone can do this).
    let payer = env.payer.insecure_clone();
    let ix = Instruction::new_with_bytes(ATA, &[1], vec![
        AccountMeta::new(payer.pubkey(), true), AccountMeta::new(alt_ta, false),
        AccountMeta::new_readonly(alt_pda, false), AccountMeta::new_readonly(env.mint, false),
        AccountMeta::new_readonly(Address::default(), false), AccountMeta::new_readonly(T22, false)]);
    send(&mut env.svm, &payer, &[], &[ix]).unwrap();
    let mut d = vec![14u8]; d.extend_from_slice(&500u64.to_le_bytes()); d.push(DECIMALS);
    let ix = Instruction::new_with_bytes(T22, &d, vec![AccountMeta::new(env.mint, false),
        AccountMeta::new(alt_ta, false), AccountMeta::new_readonly(payer.pubkey(), true)]);
    send(&mut env.svm, &payer, &[], &[ix]).unwrap();

    // Signature #1 with the WOTS key: spend the canonical vault.
    let dest = token_account(&mut env, &Address::new_unique());
    let refund = token_account(&mut env, &Address::new_unique());
    let ix = spend_ix(&env, &v, dest, refund, payer.pubkey(), 1000, 1000);
    send(&mut env.svm, &payer, &[&v.owner], &[cu_limit(), ix]).unwrap();
    assert!(env.svm.get_account(&v.pda).unwrap().owner == env.prog, "canonical vault marked spent");

    // Signature #2 with the SAME WOTS key over a different message: accepted.
    let alt = Vault { master: v.master, seed: v.seed, owner: v.owner.insecure_clone(), pda: alt_pda, bump: alt_bump, ta: alt_ta };
    let dest2 = token_account(&mut env, &Address::new_unique());
    let ix = spend_ix(&env, &alt, dest2, refund, payer.pubkey(), 500, 500);
    expect_err(send(&mut env.svm, &payer, &[&alt.owner], &[cu_limit(), ix]), 2);
    assert_eq!(balance(&env.svm, &alt_ta), Some(500));
}
