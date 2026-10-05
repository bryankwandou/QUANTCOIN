//! Mutation killers for surviving mutants M02, M17, M18, M20, M22, M23.
//! Helpers are copied verbatim from vault.rs. Build the program first: `cargo build-sbf`.
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


fn run(env: &mut Env, signers: &[&Keypair], ix: Instruction) -> Result<u64, String> {
    let payer = env.payer.insecure_clone();
    send(&mut env.svm, &payer, signers, &[cu_limit(), ix])
}

/// M02: a fake system program must be refused by the program's own check
/// (BadInstruction = 1), not by a later CPI failure.
#[test]
fn m02_fake_system_program_exact_error() {
    let mut env = setup();
    let v = new_vault(&mut env, 1000);
    let dest = token_account(&mut env, &Address::new_unique());
    let refund = token_account(&mut env, &Address::new_unique());
    let mut ix = spend_ix(&env, &v, dest, refund, env.payer.pubkey(), 1000, 1000);
    ix.accounts[8].pubkey = Address::new_unique();
    expect_err(run(&mut env, &[&v.owner], ix), 1);
    assert_eq!(balance(&env.svm, &v.ta), Some(1000));
}

/// M17: a spend of exactly 1 token must reach the destination.
#[test]
fn m17_spend_exactly_one_token() {
    let mut env = setup();
    let v = new_vault(&mut env, 1000);
    let dest = token_account(&mut env, &Address::new_unique());
    let refund = token_account(&mut env, &Address::new_unique());
    let ix = spend_ix(&env, &v, dest, refund, env.payer.pubkey(), 1, 1);
    run(&mut env, &[&v.owner], ix).unwrap();
    assert_eq!(balance(&env.svm, &dest), Some(1));
    assert_eq!(balance(&env.svm, &refund), Some(999));
    assert_eq!(balance(&env.svm, &v.ta), None);
}

/// M18: a spend that leaves exactly 1 token must refund that token.
#[test]
fn m18_spend_leaving_exactly_one_token_refunds_it() {
    let mut env = setup();
    let v = new_vault(&mut env, 1000);
    let dest = token_account(&mut env, &Address::new_unique());
    let refund = token_account(&mut env, &Address::new_unique());
    let ix = spend_ix(&env, &v, dest, refund, env.payer.pubkey(), 999, 999);
    run(&mut env, &[&v.owner], ix).unwrap();
    assert_eq!(balance(&env.svm, &dest), Some(999));
    assert_eq!(balance(&env.svm, &refund), Some(1));
    assert_eq!(balance(&env.svm, &v.ta), None);
}

/// M20: any discriminator other than 0 is BadInstruction (1), even with an
/// otherwise valid, correctly signed payload.
#[test]
fn m20_wrong_discriminator_is_bad_instruction() {
    let mut env = setup();
    let v = new_vault(&mut env, 1000);
    let dest = token_account(&mut env, &Address::new_unique());
    let refund = token_account(&mut env, &Address::new_unique());
    for b in [1u8, 2, 255] {
        let mut ix = spend_ix(&env, &v, dest, refund, env.payer.pubkey(), 1000, 1000);
        ix.data[0] = b;
        env.svm.expire_blockhash();
        expect_err(run(&mut env, &[&v.owner], ix), 1);
        assert_eq!(balance(&env.svm, &v.ta), Some(1000));
    }
}

/// M23: more than 9 accounts is BadInstruction (1); the spend must not run.
#[test]
fn m23_more_than_nine_accounts_rejected() {
    let mut env = setup();
    let v = new_vault(&mut env, 1000);
    let dest = token_account(&mut env, &Address::new_unique());
    let refund = token_account(&mut env, &Address::new_unique());
    for extra in [1usize, 2] {
        let mut ix = spend_ix(&env, &v, dest, refund, env.payer.pubkey(), 1000, 1000);
        for _ in 0..extra {
            ix.accounts.push(AccountMeta::new_readonly(Address::new_unique(), false));
        }
        env.svm.expire_blockhash();
        expect_err(run(&mut env, &[&v.owner], ix), 1);
        assert_eq!(balance(&env.svm, &v.ta), Some(1000));
    }
}

/// M22: a mint account shorter than 45 bytes must be refused with
/// NotATokenAccount (4). The vault token account is a well-formed, empty
/// account owned by the vault, so without the length check the spend of 0
/// would succeed and the test fails.
#[test]
fn m22_short_mint_data_is_not_a_token_account() {
    let mut env = setup();
    // Token accounts must be created while env.mint is still the real mint.
    let donor = token_account(&mut env, &Address::new_unique());
    let dest = token_account(&mut env, &Address::new_unique());
    let refund = token_account(&mut env, &Address::new_unique());
    let real_mint = env.svm.get_account(&env.mint).unwrap();
    let fake_mint = Address::new_unique();
    let mut short = real_mint.clone();
    short.data.truncate(44);
    env.svm.set_account(fake_mint, short).unwrap();
    env.mint = fake_mint;

    let master: [u8; 32] = rand_bytes();
    let seed: [u8; 16] = rand_bytes();
    let owner = Keypair::new();
    let pk = wots::keys::public_key_hash(&master, &seed);
    let (pda, bump) = Address::find_program_address(&[VAULT_SEED, &pk, owner.pubkey().as_ref()], &env.prog);
    let (ta, _) = Address::find_program_address(&[pda.as_ref(), T22.as_ref(), fake_mint.as_ref()], &ATA);
    // Clone a real, initialised token account and point it at the vault and fake mint.
    let mut acct = env.svm.get_account(&donor).unwrap();
    acct.data[0..32].copy_from_slice(fake_mint.as_ref());
    acct.data[32..64].copy_from_slice(pda.as_ref());
    acct.data[64..72].copy_from_slice(&0u64.to_le_bytes());
    env.svm.set_account(ta, acct).unwrap();
    let v = Vault { master, seed, owner, pda, bump, ta };

    let ix = spend_ix(&env, &v, dest, refund, env.payer.pubkey(), 0, 0);
    expect_err(run(&mut env, &[&v.owner], ix), 4);
    assert!(env.svm.get_account(&v.pda).map_or(true, |a| a.owner != env.prog), "vault must not be marked spent");
}
