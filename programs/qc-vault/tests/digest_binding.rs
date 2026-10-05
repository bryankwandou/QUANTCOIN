//! Digest-binding tests (closes mutant M09 and its siblings).
//!
//! `spend_digest` covers: program id, vault, mint, destination, refund
//! (next vault) token account, rent receiver and amount. The vault address
//! additionally commits to the WOTS pk hash, the owner and the bump through
//! the PDA derivation. Each test signs a valid spend, changes ONLY that field
//! and asserts the program answers BadSignature (Custom(2)) -- not merely
//! "some failure". Afterwards the untouched original must still succeed,
//! which proves the rejection was caused by the changed field alone.
//!
//! Needs the real binary: `cargo build-sbf` -> target/deploy/qc_vault.so.
use litesvm::LiteSVM;
use qc_vault::{spend_digest, wots, VAULT_SEED};
use sha2::{Digest, Sha256};
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

const BAD_SIGNATURE: u32 = 2;
const NOT_A_TOKEN_ACCOUNT: u32 = 4;
const MISSING_OWNER_SIGNATURE: u32 = 7;

// ---------- harness (same shape as tests/vault.rs) ----------
struct Env { svm: LiteSVM, prog: Address, payer: Keypair, mint: Address }
struct Vault { master: [u8; 32], seed: [u8; 16], owner: Keypair, pda: Address, bump: u8, ta: Address }

/// Everything a spend ix is made of, so a test can change exactly one piece.
#[derive(Clone)]
struct Spend {
    // fields hashed into the digest
    prog: Address, vault: Address, mint: Address, dest: Address, refund: Address, rent_to: Address,
    signed_amount: u64,
    // what is actually put in the transaction
    tx_amount: u64, bump: u8, vault_ta: Address,
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

fn make_mint(svm: &mut LiteSVM, payer: &Keypair) -> Address {
    let mint_kp = Keypair::new();
    create(svm, payer, &mint_kp, 82, &T22);
    let mut d = vec![20u8, DECIMALS];
    d.extend_from_slice(payer.pubkey().as_ref());
    d.push(0);
    let ix = Instruction::new_with_bytes(T22, &d, vec![AccountMeta::new(mint_kp.pubkey(), false)]);
    send(svm, payer, &[], &[ix]).unwrap();
    mint_kp.pubkey()
}

fn setup() -> Env {
    let mut svm = LiteSVM::new();
    let prog = Address::new_unique();
    svm.add_program_from_file(prog, concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/qc_vault.so"))
        .unwrap();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
    let mint = make_mint(&mut svm, &payer);
    Env { svm, prog, payer, mint }
}

fn token_account(env: &mut Env, owner: &Address) -> Address {
    let kp = Keypair::new();
    create(&mut env.svm, &env.payer, &kp, 165, &T22);
    let mut d = vec![18u8];
    d.extend_from_slice(owner.as_ref());
    let ix = Instruction::new_with_bytes(
        T22, &d, vec![AccountMeta::new(kp.pubkey(), false), AccountMeta::new_readonly(env.mint, false)]);
    let payer = env.payer.insecure_clone();
    send(&mut env.svm, &payer, &[], &[ix]).unwrap();
    kp.pubkey()
}

fn balance(svm: &LiteSVM, ta: &Address) -> Option<u64> {
    svm.get_account(ta).filter(|a| a.lamports > 0).map(|a| u64::from_le_bytes(a.data[64..72].try_into().unwrap()))
}

fn rand_bytes<const L: usize>() -> [u8; L] {
    let k = Keypair::new().to_bytes();
    let mut o = [0u8; L];
    o.copy_from_slice(&k[..L]);
    o
}

fn new_vault(env: &mut Env, fund: u64) -> Vault {
    let master: [u8; 32] = rand_bytes();
    let seed: [u8; 16] = rand_bytes();
    let owner = Keypair::new();
    let pk = wots::keys::public_key_hash(&master, &seed);
    let (pda, bump) = Address::find_program_address(&[VAULT_SEED, &pk, owner.pubkey().as_ref()], &env.prog);
    let (ta, _) = Address::find_program_address(&[pda.as_ref(), T22.as_ref(), env.mint.as_ref()], &ATA);
    let ix = Instruction::new_with_bytes(ATA, &[1], vec![
        AccountMeta::new(env.payer.pubkey(), true), AccountMeta::new(ta, false),
        AccountMeta::new_readonly(pda, false), AccountMeta::new_readonly(env.mint, false),
        AccountMeta::new_readonly(Address::default(), false), AccountMeta::new_readonly(T22, false)]);
    let payer = env.payer.insecure_clone();
    send(&mut env.svm, &payer, &[], &[ix]).unwrap();
    if fund > 0 {
        let mut d = vec![14u8];
        d.extend_from_slice(&fund.to_le_bytes());
        d.push(DECIMALS);
        let ix = Instruction::new_with_bytes(T22, &d, vec![
            AccountMeta::new(env.mint, false), AccountMeta::new(ta, false),
            AccountMeta::new_readonly(env.payer.pubkey(), true)]);
        send(&mut env.svm, &payer, &[], &[ix]).unwrap();
    }
    Vault { master, seed, owner, pda, bump, ta }
}

fn cu_limit() -> Instruction {
    let mut d = vec![2u8];
    d.extend_from_slice(&1_400_000u32.to_le_bytes());
    Instruction::new_with_bytes(CB, &d, vec![])
}

fn expect_err(r: Result<u64, String>, code: u32) {
    let e = r.expect_err("transaction must fail");
    assert!(e.contains(&format!("Custom({code})")), "expected Custom({code}), got:\n{e}");
}

/// A fully consistent spend of `amount` (signed == sent).
fn honest(env: &Env, v: &Vault, dest: Address, refund: Address, rent_to: Address, amount: u64) -> Spend {
    Spend { prog: env.prog, vault: v.pda, mint: env.mint, dest, refund, rent_to,
        signed_amount: amount, tx_amount: amount, bump: v.bump, vault_ta: v.ta }
}

/// Signs the digest fields of `signed` with the vault's WOTS key and lays the
/// ix out from `s` (accounts, bump, amount), so tests can desync the two.
fn build(env: &Env, v: &Vault, s: &Spend, signed: &Spend) -> Instruction {
    let digest = spend_digest(signed.prog.as_array(), signed.vault.as_array(), signed.mint.as_array(),
        signed.dest.as_array(), signed.refund.as_array(), signed.rent_to.as_array(), signed.signed_amount);
    let sig = wots::keys::sign(&v.master, &v.seed, &digest);
    let mut d = vec![0u8, s.bump];
    d.extend_from_slice(&v.seed);
    d.extend_from_slice(&s.tx_amount.to_le_bytes());
    d.extend_from_slice(&sig);
    Instruction::new_with_bytes(env.prog, &d, vec![
        AccountMeta::new(s.vault, false),
        AccountMeta::new(s.vault_ta, false),
        AccountMeta::new_readonly(s.mint, false),
        AccountMeta::new(s.dest, false),
        AccountMeta::new(s.refund, false),
        AccountMeta::new(s.rent_to, false),
        AccountMeta::new_readonly(T22, false),
        AccountMeta::new_readonly(v.owner.pubkey(), true),
        AccountMeta::new_readonly(Address::default(), false),
    ])
}

struct Fixture { env: Env, v: Vault, dest: Address, refund: Address, honest: Spend }

fn fixture() -> Fixture {
    let mut env = setup();
    let v = new_vault(&mut env, 1000);
    let dest = token_account(&mut env, &Address::new_unique());
    let refund = token_account(&mut env, &Address::new_unique());
    let rent_to = Address::new_unique();
    let honest = honest(&env, &v, dest, refund, rent_to, 400);
    Fixture { env, v, dest, refund, honest }
}

impl Fixture {
    /// Submits `ix` (owner co-signs, i.e. the worst case for the WOTS half).
    fn submit(&mut self, ix: Instruction) -> Result<u64, String> {
        self.env.svm.expire_blockhash();
        let payer = self.env.payer.insecure_clone();
        let owner = self.v.owner.insecure_clone();
        send(&mut self.env.svm, &payer, &[&owner], &[cu_limit(), ix])
    }
    /// Nothing moved, vault not marked spent.
    fn assert_untouched(&self) {
        assert_eq!(balance(&self.env.svm, &self.v.ta), Some(1000), "vault balance changed");
        assert_eq!(balance(&self.env.svm, &self.dest), Some(0));
        assert_eq!(balance(&self.env.svm, &self.refund), Some(0));
        assert_ne!(self.env.svm.get_account(&self.v.pda).map(|a| a.owner), Some(self.env.prog), "vault marked spent");
    }
    /// The honest spend still works afterwards: only the mutated field was wrong.
    fn assert_honest_still_succeeds(&mut self) {
        let ix = build(&self.env, &self.v, &self.honest, &self.honest);
        self.submit(ix).expect("honest spend must succeed after the rejected attempt");
        assert_eq!(balance(&self.env.svm, &self.dest), Some(400));
        assert_eq!(balance(&self.env.svm, &self.refund), Some(600));
    }
}

// ---------- pure digest sanity: every field changes the digest ----------
#[test]
fn digest_changes_with_every_field() {
    let a = |n: u8| [n; 32];
    let base = spend_digest(&a(1), &a(2), &a(3), &a(4), &a(5), &a(6), 7);
    let variants = [
        ("program", spend_digest(&a(9), &a(2), &a(3), &a(4), &a(5), &a(6), 7)),
        ("vault", spend_digest(&a(1), &a(9), &a(3), &a(4), &a(5), &a(6), 7)),
        ("mint", spend_digest(&a(1), &a(2), &a(9), &a(4), &a(5), &a(6), 7)),
        ("destination", spend_digest(&a(1), &a(2), &a(3), &a(9), &a(5), &a(6), 7)),
        ("refund", spend_digest(&a(1), &a(2), &a(3), &a(4), &a(9), &a(6), 7)),
        ("rent_to", spend_digest(&a(1), &a(2), &a(3), &a(4), &a(5), &a(9), 7)),
        ("amount", spend_digest(&a(1), &a(2), &a(3), &a(4), &a(5), &a(6), 8)),
    ];
    for (name, d) in variants {
        assert_ne!(d, base, "digest ignores {name}");
    }
}

// ---------- one test per bound field ----------
#[test]
fn field_program_id_is_bound() {
    let mut f = fixture();
    // Signed for a different program id (the signature cannot be replayed
    // under another deployment of the same code).
    let mut signed = f.honest.clone();
    signed.prog = Address::new_unique();
    let ix = build(&f.env, &f.v, &f.honest, &signed);
    expect_err(f.submit(ix), BAD_SIGNATURE);
    f.assert_untouched();
    f.assert_honest_still_succeeds();
}

#[test]
fn field_vault_is_bound() {
    let mut f = fixture();
    // Signature made for `v`, submitted against a different (funded) vault.
    let v2 = new_vault(&mut f.env, 1000);
    let mut sent = f.honest.clone();
    sent.vault = v2.pda;
    sent.vault_ta = v2.ta;
    let ix = build(&f.env, &f.v, &sent, &f.honest);
    expect_err(f.submit(ix), BAD_SIGNATURE);
    assert_eq!(balance(&f.env.svm, &v2.ta), Some(1000));
    f.assert_untouched();
    f.assert_honest_still_succeeds();
}

#[test]
fn field_mint_is_bound() {
    let mut f = fixture();
    // Signature made for mint A, submitted with mint B in the mint slot.
    // Without the mint in the digest the signature would verify and the
    // failure would surface later as NotATokenAccount (4), not BadSignature.
    let payer = f.env.payer.insecure_clone();
    let mint_b = make_mint(&mut f.env.svm, &payer);
    let mut sent = f.honest.clone();
    sent.mint = mint_b;
    let ix = build(&f.env, &f.v, &sent, &f.honest);
    let r = f.submit(ix);
    let e = r.clone().expect_err("must fail");
    assert!(!e.contains(&format!("Custom({NOT_A_TOKEN_ACCOUNT})")),
        "mint is NOT bound by the digest: signature verified, failure came later:\n{e}");
    expect_err(r, BAD_SIGNATURE);
    f.assert_untouched();
    f.assert_honest_still_succeeds();
}

#[test]
fn field_destination_is_bound() {
    let mut f = fixture();
    let evil = token_account(&mut f.env, &Address::new_unique());
    let mut sent = f.honest.clone();
    sent.dest = evil;
    let ix = build(&f.env, &f.v, &sent, &f.honest);
    expect_err(f.submit(ix), BAD_SIGNATURE);
    assert_eq!(balance(&f.env.svm, &evil), Some(0));
    f.assert_untouched();
    f.assert_honest_still_succeeds();
}

#[test]
fn field_refund_next_vault_is_bound() {
    let mut f = fixture();
    let evil = token_account(&mut f.env, &Address::new_unique());
    let mut sent = f.honest.clone();
    sent.refund = evil;
    let ix = build(&f.env, &f.v, &sent, &f.honest);
    expect_err(f.submit(ix), BAD_SIGNATURE);
    assert_eq!(balance(&f.env.svm, &evil), Some(0));
    f.assert_untouched();
    f.assert_honest_still_succeeds();
}

#[test]
fn field_rent_receiver_is_bound() {
    let mut f = fixture();
    let evil = Address::new_unique();
    let mut sent = f.honest.clone();
    sent.rent_to = evil;
    let ix = build(&f.env, &f.v, &sent, &f.honest);
    expect_err(f.submit(ix), BAD_SIGNATURE);
    assert!(f.env.svm.get_account(&evil).is_none());
    f.assert_untouched();
    f.assert_honest_still_succeeds();
}

#[test]
fn field_amount_is_bound() {
    let mut f = fixture();
    for tx_amount in [401u64, 399, 0, 1000] {
        let mut sent = f.honest.clone();
        sent.tx_amount = tx_amount;
        let ix = build(&f.env, &f.v, &sent, &f.honest);
        expect_err(f.submit(ix), BAD_SIGNATURE);
        f.assert_untouched();
    }
    f.assert_honest_still_succeeds();
}

#[test]
fn field_bump_owner_and_seed_are_bound_via_vault_address() {
    let mut f = fixture();
    // Different bump byte: PDA no longer matches.
    let mut sent = f.honest.clone();
    sent.bump = f.v.bump.wrapping_sub(1);
    let ix = build(&f.env, &f.v, &sent, &f.honest);
    expect_err(f.submit(ix), BAD_SIGNATURE);
    // Different owner key (also signing): vault address derivation differs.
    let thief = Keypair::new();
    let mut ix = build(&f.env, &f.v, &f.honest, &f.honest);
    ix.accounts[7].pubkey = thief.pubkey();
    f.env.svm.expire_blockhash();
    let payer = f.env.payer.insecure_clone();
    expect_err(send(&mut f.env.svm, &payer, &[&thief], &[cu_limit(), ix]), BAD_SIGNATURE);
    // Different WOTS public seed byte.
    let mut ix = build(&f.env, &f.v, &f.honest, &f.honest);
    ix.data[2] ^= 0x80;
    expect_err(f.submit(ix), BAD_SIGNATURE);
    f.assert_untouched();
    f.assert_honest_still_succeeds();
}

// ---------- front-running ----------
/// An attacker copies the signed instruction data of a pending spend and
/// resubmits it with other recipient accounts. Worst case: the owner key
/// co-signs (e.g. compromised / forged), so only the WOTS binding is left.
#[test]
fn front_running_resubmit_with_other_accounts_is_rejected() {
    let mut f = fixture();
    let pending = build(&f.env, &f.v, &f.honest, &f.honest); // what the victim broadcast
    let attacker = token_account(&mut f.env, &Address::new_unique());
    let attacker_sol = Address::new_unique();

    let cases: [(&str, usize, Address); 3] = [
        ("destination", 3, attacker),
        ("next vault (refund)", 4, attacker),
        ("rent receiver", 5, attacker_sol),
    ];
    for (name, slot, key) in cases {
        let mut ix = pending.clone();
        ix.accounts[slot].pubkey = key;
        let e = f.submit(ix).expect_err(name);
        assert!(e.contains("Custom(2)"), "front-run via {name} not rejected with BadSignature:\n{e}");
    }
    // all three at once
    let mut ix = pending.clone();
    ix.accounts[3].pubkey = attacker;
    ix.accounts[4].pubkey = attacker;
    ix.accounts[5].pubkey = attacker_sol;
    // (dest == refund would hit DuplicateAccount first; use a second attacker account)
    let attacker2 = token_account(&mut f.env, &Address::new_unique());
    ix.accounts[4].pubkey = attacker2;
    expect_err(f.submit(ix), BAD_SIGNATURE);
    assert_eq!(balance(&f.env.svm, &attacker), Some(0));
    assert_eq!(balance(&f.env.svm, &attacker2), Some(0));
    f.assert_untouched();

    // Without the owner's Ed25519 signature the copy dies even earlier.
    let mut ix = pending.clone();
    ix.accounts[3].pubkey = attacker;
    ix.accounts[7].is_signer = false;
    f.env.svm.expire_blockhash();
    let payer = f.env.payer.insecure_clone();
    expect_err(send(&mut f.env.svm, &payer, &[], &[cu_limit(), ix]), MISSING_OWNER_SIGNATURE);
    f.assert_untouched();

    // The victim's original transaction still lands exactly as signed.
    f.submit(pending).expect("victim's pending spend must still succeed");
    assert_eq!(balance(&f.env.svm, &f.dest), Some(400));
    assert_eq!(balance(&f.env.svm, &f.refund), Some(600));
    assert_eq!(balance(&f.env.svm, &attacker), Some(0));
}

// ---------- differential WOTS test ----------
// Independent reference, written only from this spec (never calls wots.rs):
//   N = 24 byte chain values, w = 256, 26 chains (24 message + 2 checksum).
//   H(x...)           = SHA-256 of the concatenation.
//   step(i, s, x)     = H("QCV1/chain" || seed(16) || [i] || [s] || x)[0..24]
//   digits(m[24])     = m[0..24], then C = sum(255 - m[j]) as big-endian u16 -> 2 digits.
//   recovery: for chain i apply step for s = d[i] .. 254 (255 - d[i] steps) to
//             signature element i; the public chain end is position 255.
//   pk_hash           = H("QCV1/pk" || seed || end_0 || ... || end_25)
//   sk_i              = H("QCV1/sk" || master(32) || [i])[0..24]
//   sign: element i = step applied for s = 0 .. d[i]-1 starting at sk_i.
fn sha(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts { h.update(p); }
    h.finalize().into()
}
fn r_step(seed: &[u8], i: usize, s: usize, x: &[u8]) -> Vec<u8> {
    sha(&[b"QCV1/chain", seed, &[i as u8], &[s as u8], x])[..24].to_vec()
}
fn r_digits(m: &[u8]) -> Vec<usize> {
    let mut d: Vec<usize> = m.iter().map(|b| *b as usize).collect();
    let c: usize = m.iter().map(|b| 255 - *b as usize).sum();
    d.push(c >> 8);
    d.push(c & 0xff);
    d
}
fn r_recover(seed: &[u8], m: &[u8], sig: &[u8]) -> [u8; 32] {
    let d = r_digits(m);
    let mut ends = Vec::new();
    for i in 0..26 {
        let mut v = sig[i * 24..i * 24 + 24].to_vec();
        for s in d[i]..255 { v = r_step(seed, i, s, &v); }
        ends.extend_from_slice(&v);
    }
    sha(&[b"QCV1/pk", seed, &ends])
}
fn r_sk(master: &[u8], i: usize) -> Vec<u8> { sha(&[b"QCV1/sk", master, &[i as u8]])[..24].to_vec() }
fn r_sign(master: &[u8], seed: &[u8], m: &[u8]) -> Vec<u8> {
    let d = r_digits(m);
    let mut sig = Vec::new();
    for i in 0..26 {
        let mut v = r_sk(master, i);
        for s in 0..d[i] { v = r_step(seed, i, s, &v); }
        sig.extend_from_slice(&v);
    }
    sig
}
fn r_pk(master: &[u8], seed: &[u8]) -> [u8; 32] {
    let mut ends = Vec::new();
    for i in 0..26 {
        let mut v = r_sk(master, i);
        for s in 0..255 { v = r_step(seed, i, s, &v); }
        ends.extend_from_slice(&v);
    }
    sha(&[b"QCV1/pk", seed, &ends])
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 { let mut x = self.0; x ^= x << 13; x ^= x >> 7; x ^= x << 17; self.0 = x; x }
    fn fill(&mut self, b: &mut [u8]) { for x in b { *x = self.next() as u8; } }
}

#[test]
fn wots_matches_independent_reference_on_2000_random_cases() {
    const CASES: usize = 2000;
    let mut rng = Rng(0xC0FF_EE12_3456_789B);
    for case in 0..CASES {
        let mut master = [0u8; 32]; rng.fill(&mut master);
        let mut seed = [0u8; 16]; rng.fill(&mut seed);
        let mut digest = [0u8; 24];
        match case {
            0 => {}                          // all zero digits: longest chains
            1 => digest = [255; 24],         // all 255: checksum 0
            _ => rng.fill(&mut digest),
        }
        let mut garbage = [0u8; 624]; rng.fill(&mut garbage);

        // Signing agrees, and recovery of a valid signature yields the pk.
        let ref_sig = r_sign(&master, &seed, &digest);
        assert_eq!(ref_sig.as_slice(), &wots::keys::sign(&master, &seed, &digest)[..], "sign differs, case {case}");
        let lib_sig: [u8; 624] = ref_sig.clone().try_into().unwrap();
        let lib = wots::recover_pk_hash(&seed, &digest, &lib_sig);
        let want = r_pk(&master, &seed);
        assert_eq!(lib, want, "recover(valid sig) != reference pk, case {case}");
        assert_eq!(want, wots::keys::public_key_hash(&master, &seed), "pk differs, case {case}");
        assert_eq!(wots::digits(&digest).iter().map(|d| *d as usize).collect::<Vec<_>>(), r_digits(&digest));

        // Arbitrary (invalid) signature and a flipped-digest message: same output.
        assert_eq!(wots::recover_pk_hash(&seed, &digest, &garbage), r_recover(&seed, &digest, &garbage),
            "recover(garbage) differs, case {case}");
        let mut other = digest; other[case % 24] ^= 1 << (case % 8);
        assert_eq!(wots::recover_pk_hash(&seed, &other, &lib_sig), r_recover(&seed, &other, &ref_sig),
            "recover(wrong msg) differs, case {case}");
        assert_ne!(wots::recover_pk_hash(&seed, &other, &lib_sig), want, "wrong message verified, case {case}");
    }
}
