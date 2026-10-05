//! QuantCoin quantum vault (Pinocchio, stateless).
//!
//! A vault is a PDA with seeds `["qcv", pk_hash, owner]`: `pk_hash` commits to
//! a Winternitz one-time public key, `owner` is a classical Ed25519 key.
//! Spending requires BOTH (hybrid): an attacker must break Ed25519 and
//! SHA-256 at once. The PDA owns a Token-2022 account. The
//! PDA has no private key, so the only way to move the tokens is the `Spend`
//! instruction below. A quantum computer running Shor's algorithm can forge
//! the Ed25519 half but not the hash-based half, so the balance stays safe.
//!
//! The program stores no state and has one instruction, which keeps the
//! binary (and therefore the deploy rent) small.
//!
//! Spend — instruction data:
//!   [0]          discriminator = 0
//!   [1]          vault PDA bump
//!   [2..18]      WOTS public seed (16 bytes)
//!   [18..26]     amount to send to `destination` (u64 LE)
//!   [26..650]    WOTS signature (26 chains x 24 bytes)
//!
//! Accounts:
//!   0. `[writable]` vault PDA (becomes the spent marker, see below)
//!   1. `[writable]` vault token account: the PDA's Token-2022 associated
//!                   token account for `mint` (any other account is refused)
//!   2. `[]`         mint
//!   3. `[writable]` destination token account
//!   4. `[writable]` refund token account: receives `balance - amount`,
//!                   normally the token account of the owner's NEXT vault
//!   5. `[writable]` rent receiver for the closed vault token account
//!   6. `[]`         Token-2022 program
//!   7. `[signer]`   owner (Ed25519), bound into the vault address
//!   8. `[]`         System program
//!
//! The signed message binds program, vault, mint, all three recipients and
//! the amount, so whoever relays the transaction (and pays its fee) cannot
//! redirect anything. The vault token account is closed after the spend.
//!
//! One spend per vault, enforced on chain: the closed account's rent is paid
//! into the vault PDA, which is then assigned to this program (0 bytes,
//! rent-exempt). A vault owned by this program is spent and refused forever,
//! so the public WOTS signature cannot be replayed against a token account
//! created later for the same vault (finding M-1). Tokens sent to a spent
//! vault stay locked. The rent above the 0-byte minimum goes to `rent_to`.
#![cfg_attr(target_os = "solana", no_std)]

pub mod wots;

use pinocchio::{
    address::Address,
    cpi::{invoke_signed_unchecked, CpiAccount, Seed, Signer},
    instruction::{InstructionAccount, InstructionView},
    AccountView,
};

#[cfg(not(feature = "no-entrypoint"))]
mod entry {
    use pinocchio::entrypoint::lazy::{InstructionContext, MaybeAccount};

    /// Lazy entrypoint: reads exactly nine accounts straight from the input
    /// buffer instead of pinocchio's generic parser. Together with returning
    /// raw error codes this saves ~3 KB of bytecode (~0.02 SOL of rent).
    #[no_mangle]
    pub unsafe extern "C" fn entrypoint(input: *mut u8) -> u64 {
        let mut ctx = InstructionContext::new_unchecked(input);
        if ctx.remaining() != 9 {
            return super::VaultError::BadInstruction as u64;
        }
        let mut accounts: [core::mem::MaybeUninit<pinocchio::AccountView>; 9] =
            [const { core::mem::MaybeUninit::uninit() }; 9];
        for slot in accounts.iter_mut() {
            match ctx.next_account_unchecked() {
                MaybeAccount::Account(a) => {
                    slot.write(a);
                }
                // Every account must be distinct.
                MaybeAccount::Duplicated(_) => return super::VaultError::DuplicateAccount as u64,
            }
        }
        let accounts = &mut *(&mut accounts as *mut _ as *mut [pinocchio::AccountView; 9]);
        match super::process_instruction(
            ctx.program_id_unchecked(),
            accounts,
            ctx.instruction_data_unchecked(),
        ) {
            Ok(()) => 0,
            Err(e) => e as u64,
        }
    }

    pinocchio::no_allocator!();
    pinocchio::nostd_panic_handler!();
}

pub const VAULT_SEED: &[u8] = b"qcv";
pub const TOKEN_2022: Address = Address::new_from_array([6, 221, 246, 225, 238, 117, 143, 222, 24, 66, 93, 188, 228, 108, 205, 218, 182, 26, 252, 77, 131, 185, 13, 39, 254, 189, 249, 40, 216, 161, 139, 252]); // TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
pub const SYSTEM: Address = Address::new_from_array([0; 32]);
pub const ATA_PROGRAM: Address = Address::new_from_array([140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89]); // ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL
pub const IX_SPEND: u8 = 0;
pub const SPEND_DATA_LEN: usize = 26 + wots::SIG_LEN;

/// Error codes, returned raw (they surface as `custom program error: 0x..`).
#[repr(u32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VaultError {
    BadInstruction = 1,
    BadSignature = 2,
    InsufficientBalance = 3,
    NotATokenAccount = 4,
    BadTokenProgram = 5,
    DuplicateAccount = 6,
    MissingOwnerSignature = 7,
    AlreadySpent = 8,
}


/// Message digest the WOTS key signs. Shared with off-chain clients.
pub fn spend_digest(
    program_id: &[u8; 32],
    vault: &[u8; 32],
    mint: &[u8; 32],
    destination: &[u8; 32],
    refund: &[u8; 32],
    rent_to: &[u8; 32],
    amount: u64,
) -> [u8; wots::MSG_DIGITS] {
    let h = wots::hashv(&[
        wots::DOMAIN_MSG,
        program_id,
        vault,
        mint,
        destination,
        refund,
        rent_to,
        &amount.to_le_bytes(),
    ]);
    let mut d = [0u8; wots::MSG_DIGITS];
    // SAFETY: MSG_DIGITS (24) <= 32.
    unsafe { core::ptr::copy_nonoverlapping(h.as_ptr(), d.as_mut_ptr(), wots::MSG_DIGITS) };
    d
}

pub fn process_instruction(
    program_id: &Address,
    accounts: &mut [AccountView; 9],
    data: &[u8],
) -> Result<(), VaultError> {
    if data.len() != SPEND_DATA_LEN || data[0] != IX_SPEND {
        return Err(VaultError::BadInstruction);
    }
    let [vault, vault_ta, mint, destination, refund, rent_to, token_program, owner, system] = accounts;
    if vault.owned_by(program_id) {
        return Err(VaultError::AlreadySpent);
    }
    if system.address() != &SYSTEM {
        return Err(VaultError::BadInstruction);
    }

    // Hybrid rule, part 1: the classical Ed25519 owner must sign. Today this
    // alone already protects the vault; it also covers any flaw in part 2.
    if !owner.is_signer() {
        return Err(VaultError::MissingOwnerSignature);
    }

    // SAFETY: length checked above; all offsets are in bounds.
    let (bump, seed, amount, sig) = unsafe {
        let p = data.as_ptr();
        (
            [*p.add(1)],
            &*(p.add(2) as *const [u8; wots::SEED_LEN]),
            u64::from_le_bytes(*(p.add(18) as *const [u8; 8])),
            &*(p.add(26) as *const [u8; wots::SIG_LEN]),
        )
    };

    // Hybrid rule, part 2: the Winternitz signature must be valid. After a
    // quantum computer breaks Ed25519, this alone still protects the vault.
    // 1. Signature → public key commitment → vault address.
    let digest = spend_digest(
        program_id.as_array(),
        vault.address().as_array(),
        mint.address().as_array(),
        destination.address().as_array(),
        refund.address().as_array(),
        rent_to.address().as_array(),
        amount,
    );
    let pk_hash = wots::recover_pk_hash(seed, &digest, sig);
    match pda(&[VAULT_SEED, &pk_hash, owner.address().as_ref(), &bump], program_id, false) {
        Some(a) if &a == vault.address() => {}
        _ => return Err(VaultError::BadSignature),
    }
    // Only the canonical bump is accepted: every higher bump must be on-curve.
    // Otherwise one WOTS key guards several vault addresses and the per-address
    // spent marker lets the same key sign a second message.
    let mut b = bump[0];
    while b < 255 {
        b += 1;
        if pda(&[VAULT_SEED, &pk_hash, owner.address().as_ref(), &[b]], program_id, false).is_some() {
            return Err(VaultError::BadSignature);
        }
    }

    // 2. Read balance and decimals. The token program re-checks ownership,
    //    mint and authority during the CPIs; these reads only need to be
    //    well-formed.
    let tp = token_program.address();
    if tp != &TOKEN_2022 {
        return Err(VaultError::BadTokenProgram);
    }
    // The spend drains the vault's associated token account and nothing else.
    // The digest binds vault and mint, which fix that address, so a forged
    // owner signature (post-quantum) cannot aim a signed spend at a decoy token
    // account the PDA also owns: that would mark the vault spent and lock the
    // real balance for good (finding F9).
    match pda(&[vault.address().as_ref(), TOKEN_2022.as_ref(), mint.address().as_ref()], &ATA_PROGRAM, true) {
        Some(ata) if &ata == vault_ta.address() => {}
        _ => return Err(VaultError::NotATokenAccount),
    }
    // No owner check on the two accounts read below: a fake account only
    // yields a fake balance, and the Token-2022 CPIs then reject it.
    if vault_ta.data_len() < 72 || mint.data_len() < 45 {
        return Err(VaultError::NotATokenAccount);
    }
    // SAFETY: lengths checked just above; no mutable borrow exists yet.
    let (balance, decimals) = unsafe {
        let ta = vault_ta.borrow_unchecked();
        let m = mint.borrow_unchecked();
        (u64::from_le_bytes(*(ta.as_ptr().add(64) as *const [u8; 8])), *m.as_ptr().add(44))
    };
    let rest = balance
        .checked_sub(amount)
        .ok_or(VaultError::InsufficientBalance)?;

    // 3. Move everything out, then close. The PDA signs via its seeds.
    //    Hand-written CPIs (instead of the pinocchio-token builders) keep the
    //    binary small; the layouts are the stable Token-2022 ones.
    let seeds = [
        Seed::from(VAULT_SEED),
        Seed::from(&pk_hash),
        Seed::from(owner.address().as_ref()),
        Seed::from(&bump),
    ];
    let signer = [Signer::from(&seeds)];
    if amount > 0 {
        transfer_checked(tp, vault_ta, mint, destination, vault, amount, decimals, &signer);
    }
    if rest > 0 {
        transfer_checked(tp, vault_ta, mint, refund, vault, rest, decimals, &signer);
    }
    // Close into the vault PDA itself: its lamports fund the spent marker.
    let accs = [
        InstructionAccount::writable(vault_ta.address()),
        InstructionAccount::writable(vault.address()),
        InstructionAccount::writable_signer(vault.address()),
    ];
    let ix = InstructionView { program_id: tp, data: &[9], accounts: &accs };
    // SAFETY: no account data borrow is held across the CPI.
    unsafe {
        invoke_signed_unchecked(
            &ix,
            &[CpiAccount::from(&*vault_ta), CpiAccount::from(&*vault), CpiAccount::from(&*vault)],
            &signer,
        )
    };

    // 4. Mark spent: System Assign(vault -> this program), signed by the PDA.
    let mut assign = [0u8; 36];
    assign[0] = 1;
    // SAFETY: 4 + 32 = 36 bytes; raw copy keeps panic machinery out.
    unsafe { core::ptr::copy_nonoverlapping(program_id.as_array().as_ptr(), assign.as_mut_ptr().add(4), 32) };
    let accs = [InstructionAccount::writable_signer(vault.address())];
    let ix = InstructionView { program_id: &SYSTEM, data: &assign, accounts: &accs };
    // SAFETY: no account data borrow is held across the CPI.
    unsafe { invoke_signed_unchecked(&ix, &[CpiAccount::from(&*vault)], &signer) };

    // 5. The program now owns the vault and may move its surplus lamports.
    let surplus = vault.lamports().saturating_sub(marker_rent());
    if surplus > 0 {
        vault.set_lamports(vault.lamports() - surplus);
        rent_to.set_lamports(rent_to.lamports().wrapping_add(surplus)); // total SOL supply < u64::MAX
    }
    Ok(())
}

/// Rent-exempt minimum of the 0-byte spent marker, read from the Rent sysvar.
/// Only the two exemption thresholds Solana has used (1.0 and 2.0) are
/// evaluated, as the SDK does without floats. For any other value, or if the
/// sysvar cannot be read, the marker keeps all its lamports: they include the
/// closed token account's rent, so they always cover a 0-byte account.
/// A hard-coded minimum is wrong whenever rent changes: at mainnet's 5,080
/// lamports/byte the old 890,880 left a fresh `rent_to` below its own minimum
/// and every such spend failed.
#[inline(always)]
fn marker_rent() -> u64 {
    // [u64; 3] covers the 17-byte sysvar; zeroed so a failed read gives an
    // unknown threshold (0) and therefore u64::MAX.
    let mut r = [0u64; 3];
    #[cfg(target_os = "solana")]
    // SAFETY: the syscall writes the 17-byte Rent sysvar into `r` (24 bytes).
    #[allow(deprecated)]
    unsafe {
        pinocchio::syscalls::sol_get_rent_sysvar(r.as_mut_ptr() as *mut u8)
    };
    let (per_byte, threshold) = (u64::from_le(r[0]), u64::from_le(r[1]));
    // 1.0 -> 128 bytes of rent-years, 2.0 -> 256 (per_byte << 7 or << 8).
    let shift = match threshold {
        0x3FF0_0000_0000_0000 => 7,
        0x4000_0000_0000_0000 => 8,
        _ => return u64::MAX,
    };
    if per_byte >> 56 != 0 {
        return u64::MAX;
    }
    per_byte << shift
}

/// Program address for `seeds`: with `find`, the canonical bump is searched
/// (seeds without bump); otherwise the last seed is the bump. Calls the
/// syscalls directly: the SDK wrappers convert errors through a function that
/// can panic, which links the panic handler and its strings (~550 bytes).
#[inline(always)]
fn pda(seeds: &[&[u8]], program: &Address, find: bool) -> Option<Address> {
    #[cfg(target_os = "solana")]
    {
        let mut out = core::mem::MaybeUninit::<Address>::uninit();
        let mut bump = 0u8;
        let (s, n, p, o) = (seeds.as_ptr() as *const u8, seeds.len() as u64, program as *const _ as *const u8, out.as_mut_ptr() as *mut u8);
        // SAFETY: the syscalls write 32 bytes to `out` (and 1 to `bump`) on success.
        let rc = unsafe {
            if find {
                pinocchio::syscalls::sol_try_find_program_address(s, n, p, o, &mut bump)
            } else {
                pinocchio::syscalls::sol_create_program_address(s, n, p, o)
            }
        };
        if rc == 0 { Some(unsafe { out.assume_init() }) } else { None }
    }
    #[cfg(not(target_os = "solana"))]
    {
        if find {
            Address::try_find_program_address(seeds, program).map(|(a, _)| a)
        } else {
            Address::create_program_address(seeds, program).ok()
        }
    }
}

/// SPL Token `TransferChecked` (discriminator 12). A failing CPI aborts the
/// whole transaction, so there is no return value to propagate.
#[allow(clippy::too_many_arguments)]
#[inline(never)]
fn transfer_checked(
    tp: &Address,
    from: &AccountView,
    mint: &AccountView,
    to: &AccountView,
    authority: &AccountView,
    amount: u64,
    decimals: u8,
    signer: &[Signer],
) {
    let mut data = [0u8; 10];
    data[0] = 12;
    data[1..9].copy_from_slice(&amount.to_le_bytes());
    data[9] = decimals;
    let accs = [
        InstructionAccount::writable(from.address()),
        InstructionAccount::readonly(mint.address()),
        InstructionAccount::writable(to.address()),
        InstructionAccount::readonly_signer(authority.address()),
    ];
    let ix = InstructionView { program_id: tp, data: &data, accounts: &accs };
    // SAFETY: no account data borrow is held across the CPI.
    unsafe {
        invoke_signed_unchecked(
            &ix,
            &[CpiAccount::from(from), CpiAccount::from(mint), CpiAccount::from(to), CpiAccount::from(authority)],
            signer,
        )
    };
}
