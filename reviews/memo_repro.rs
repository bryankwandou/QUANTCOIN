//! Second-pass review repro (Rina Wijaya). Uses the prebuilt
//! target/deploy/qc_vault.so from the reviewed worktree; nothing in the
//! worktree is modified.
use litesvm::LiteSVM;
use qc_vault::{spend_digest, wots, VAULT_SEED};
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

const SO: &str = "<local-path>
const T22: Address = Address::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const CB: Address = Address::from_str_const("ComputeBudget111111111111111111111111111111");
const ATA: Address = Address::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const DECIMALS: u8 = 5;

struct Env { svm: LiteSVM, prog: Address, payer: Keypair, mint: Address }
struct Vault { master: [u8; 32], seed: [u8; 16], owner: Keypair, pda: Address, bump: u8, ta: Address }

fn send(svm: &mut LiteSVM, payer: &Keypair, extra: &[&Keypair], ixs: &[Instruction]) -> Result<u64, String> {
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra);
    let tx = Transaction::new(&signers, Message::new(ixs, Some(&payer.pubkey())), svm.latest_blockhash());
    svm.send_transaction(tx).map(|m| m.compute_units_consumed)
        .map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")))
}
fn create(svm: &mut LiteSVM, payer: &Keypair, kp: &Keypair, space: u64, owner: &Address) {
    let lamports = svm.minimum_balance_for_rent_exemption(space as usize);
    let ix = solana_system_interface::instruction::create_account(&payer.pubkey(), &kp.pubkey(), lamports, space, owner);
    send(svm, payer, &[kp], &[ix]).unwrap();
}
fn ata_of(env: &Env, owner: &Address) -> Address {
    Address::find_program_address(&[owner.as_ref(), T22.as_ref(), env.mint.as_ref()], &ATA).0
}
fn make_ata(env: &mut Env, owner: &Address) -> Address {
    let a = ata_of(env, owner);
    let ix = Instruction::new_with_bytes(ATA, &[1], vec![
        AccountMeta::new(env.payer.pubkey(), true), AccountMeta::new(a, false),
        AccountMeta::new_readonly(*owner, false), AccountMeta::new_readonly(env.mint, false),
        AccountMeta::new_readonly(Address::default(), false), AccountMeta::new_readonly(T22, false)]);
    let payer = env.payer.insecure_clone();
    send(&mut env.svm, &payer, &[], &[ix]).unwrap();
    a
}
fn mint_to(env: &mut Env, ta: Address, amount: u64) {
    let mut d = vec![14u8]; d.extend_from_slice(&amount.to_le_bytes()); d.push(DECIMALS);
    let ix = Instruction::new_with_bytes(T22, &d, vec![AccountMeta::new(env.mint, false), AccountMeta::new(ta, false),
        AccountMeta::new_readonly(env.payer.pubkey(), true)]);
    let payer = env.payer.insecure_clone();
    send(&mut env.svm, &payer, &[], &[ix]).unwrap();
}
fn balance(svm: &LiteSVM, ta: &Address) -> Option<u64> {
    svm.get_account(ta).filter(|a| a.lamports > 0).map(|a| u64::from_le_bytes(a.data[64..72].try_into().unwrap()))
}
fn rand_bytes<const L: usize>() -> [u8; L] {
    let k = Keypair::new().to_bytes(); let mut o = [0u8; L]; o.copy_from_slice(&k[..L]); o
}
fn setup() -> Env {
    let mut svm = LiteSVM::new();
    let prog = Address::new_unique();
    svm.add_program_from_file(prog, SO).unwrap();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
    let mint_kp = Keypair::new();
    create(&mut svm, &payer, &mint_kp, 82, &T22);
    let mut d = vec![20u8, DECIMALS]; d.extend_from_slice(payer.pubkey().as_ref()); d.push(0);
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
    let ta = make_ata(env, &pda);
    if fund > 0 { mint_to(env, ta, fund); }
    Vault { master, seed, owner, pda, bump, ta }
}
fn spend_ix(env: &Env, v: &Vault, dest: Address, refund: Address, rent_to: Address, amount: u64) -> Instruction {
    let digest = spend_digest(env.prog.as_array(), v.pda.as_array(), env.mint.as_array(), dest.as_array(),
        refund.as_array(), rent_to.as_array(), amount);
    let sig = wots::keys::sign(&v.master, &v.seed, &digest);
    let mut d = vec![0u8, v.bump]; d.extend_from_slice(&v.seed); d.extend_from_slice(&amount.to_le_bytes()); d.extend_from_slice(&sig);
    Instruction::new_with_bytes(env.prog, &d, vec![
        AccountMeta::new(v.pda, false), AccountMeta::new(v.ta, false), AccountMeta::new_readonly(env.mint, false),
        AccountMeta::new(dest, false), AccountMeta::new(refund, false), AccountMeta::new(rent_to, false),
        AccountMeta::new_readonly(T22, false), AccountMeta::new_readonly(v.owner.pubkey(), true),
        AccountMeta::new_readonly(Address::default(), false)])
}
fn cu_limit() -> Instruction {
    let mut d = vec![2u8]; d.extend_from_slice(&1_400_000u32.to_le_bytes());
    Instruction::new_with_bytes(CB, &d, vec![])
}
/// Recipient (token-account owner) turns on RequiredMemoTransfers for its own ATA:
/// Reallocate([MemoTransfer]) then MemoTransferExtension::Enable. Owner-signed only.
fn recipient_requires_memo(env: &mut Env, recipient: &Keypair, ta: Address, enable: bool) {
    let payer = env.payer.insecure_clone();
    let realloc = Instruction::new_with_bytes(T22, &[29u8, 8, 0], vec![ // Reallocate, ExtensionType::MemoTransfer = 8
        AccountMeta::new(ta, false), AccountMeta::new(payer.pubkey(), true),
        AccountMeta::new_readonly(Address::default(), false), AccountMeta::new_readonly(recipient.pubkey(), true)]);
    let toggle = Instruction::new_with_bytes(T22, &[30u8, if enable { 0 } else { 1 }], vec![
        AccountMeta::new(ta, false), AccountMeta::new_readonly(recipient.pubkey(), true)]);
    send(&mut env.svm, &payer, &[recipient], &[realloc, toggle]).unwrap();
}

/// A payee who requires incoming memos makes a correctly signed vault spend
/// fail deterministically (Token-2022 NoMemo = Custom(36)) and blocks the
/// remainder (refund) transfer with it. Only the payee can undo it.
#[test]
fn payee_memo_requirement_blocks_whole_spend() {
    let mut env = setup();
    let v = new_vault(&mut env, 1_000_000);
    let next = new_vault(&mut env, 0);            // owner's next vault receives the remainder
    let mallory = Keypair::new();
    let dest = make_ata(&mut env, &mallory.pubkey());
    recipient_requires_memo(&mut env, &mallory, dest, true);
    let rent_to = Address::new_unique();
    let payer = env.payer.insecure_clone();

    // The one message this WOTS key will ever sign: pay mallory 10, rest to next vault.
    let ix = spend_ix(&env, &v, dest, next.ta, rent_to, 10);
    for attempt in 0..3 {
        env.svm.expire_blockhash();
        let e = send(&mut env.svm, &payer, &[&v.owner], &[cu_limit(), ix.clone()]).expect_err("spend must fail");
        println!("attempt {attempt}: {}", e.lines().next().unwrap());
        assert!(e.contains("Custom(36)"), "expected Token-2022 NoMemo, got {e}");
    }
    assert_eq!(balance(&env.svm, &v.ta), Some(1_000_000), "whole balance still in the vault");
    assert_eq!(balance(&env.svm, &next.ta), Some(0), "remainder never reached the next vault");
    assert_ne!(env.svm.get_account(&v.pda).map(|a| a.owner), Some(env.prog), "vault not marked spent");

    // Only the payee can unblock the identical signed message.
    recipient_requires_memo(&mut env, &mallory, dest, false);
    env.svm.expire_blockhash();
    send(&mut env.svm, &payer, &[&v.owner], &[cu_limit(), ix]).expect("identical spend works once payee disables memo");
    assert_eq!(balance(&env.svm, &dest), Some(10));
    assert_eq!(balance(&env.svm, &next.ta), Some(999_990));
}

/// Build fingerprint: the .so under test rejects a funded non-canonical-bump vault.
#[test]
fn so_under_test_has_canonical_bump_fix() {
    let mut env = setup();
    let v = new_vault(&mut env, 0);
    let pk = wots::keys::public_key_hash(&v.master, &v.seed);
    let (alt_pda, alt_bump) = (0..v.bump).rev().find_map(|b| {
        Address::create_program_address(&[VAULT_SEED, &pk, v.owner.pubkey().as_ref(), &[b]], &env.prog).ok().map(|a| (a, b))
    }).unwrap();
    let alt_ta = make_ata(&mut env, &alt_pda);
    mint_to(&mut env, alt_ta, 500);
    let alt = Vault { master: v.master, seed: v.seed, owner: v.owner.insecure_clone(), pda: alt_pda, bump: alt_bump, ta: alt_ta };
    let dest = make_ata(&mut env, &Address::new_unique());
    let refund = make_ata(&mut env, &Address::new_unique());
    let payer = env.payer.insecure_clone();
    let ix = spend_ix(&env, &alt, dest, refund, payer.pubkey(), 500);
    let e = send(&mut env.svm, &payer, &[&alt.owner], &[cu_limit(), ix])
        .expect_err("non-canonical bump must be refused");
    assert!(e.contains("Custom(2)"), "got {e}");
    println!("canonical bump {} / refused bump {}", v.bump, alt_bump);
}
