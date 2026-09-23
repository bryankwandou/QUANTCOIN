//! Winternitz one-time signatures (WOTS, w = 256) over a SHA-256 based
//! tweakable hash truncated to 192 bits.
//!
//! Security rests only on the preimage / second-preimage resistance of
//! SHA-256. Grover's algorithm halves the exponent, so a 192-bit chain value
//! keeps ~96-bit post-quantum preimage security and the 192-bit message
//! digest keeps ~96-bit post-quantum second-preimage security. Shor's
//! algorithm (which breaks Ed25519) does not apply to hash functions.
//!
//! Every key signs exactly ONE message. Signing two different messages with
//! the same key leaks enough chain values to forge a third. The vault
//! program enforces this by draining the whole balance on every spend.
//!
//! The same code runs on-chain (via the `sol_sha256` syscall) and off-chain
//! (via the `sha2` crate), so clients and program cannot disagree.

/// Bytes per chain value.
pub const N: usize = 24;
/// Message digits: one per digest byte.
pub const MSG_DIGITS: usize = 24;
/// Checksum digits: max checksum is 24 * 255 = 6120 < 2^16.
pub const CSUM_DIGITS: usize = 2;
/// Total number of hash chains.
pub const CHAINS: usize = MSG_DIGITS + CSUM_DIGITS;
/// Last step index of a chain (w - 1).
pub const MAX_STEP: u8 = 255;
/// Signature length in bytes.
pub const SIG_LEN: usize = CHAINS * N;
/// Length of the public randomization seed.
pub const SEED_LEN: usize = 16;

pub const DOMAIN_CHAIN: &[u8] = b"QCV1/chain";
pub const DOMAIN_PK: &[u8] = b"QCV1/pk";
pub const DOMAIN_MSG: &[u8] = b"QCV1/msg";
pub const DOMAIN_SK: &[u8] = b"QCV1/sk";

/// Copies `N` bytes at `src` into a fresh chain value. Raw copies instead of
/// slice indexing keep panic/format machinery out of the on-chain binary,
/// which directly lowers deploy rent.
#[inline(always)]
fn take(src: &[u8], at: usize) -> [u8; N] {
    debug_assert!(at + N <= src.len());
    let mut out = [0u8; N];
    // SAFETY: every caller passes `at + N <= src.len()` (fixed-size arrays).
    unsafe { core::ptr::copy_nonoverlapping(src.as_ptr().add(at), out.as_mut_ptr(), N) };
    out
}

#[inline(always)]
fn put(dst: &mut [u8], at: usize, v: &[u8; N]) {
    debug_assert!(at + N <= dst.len());
    // SAFETY: as in `take`.
    unsafe { core::ptr::copy_nonoverlapping(v.as_ptr(), dst.as_mut_ptr().add(at), N) };
}

/// SHA-256 over the concatenation of `parts`.
#[inline(always)]
pub fn hashv(parts: &[&[u8]]) -> [u8; 32] {
    let mut out = [0u8; 32];
    #[cfg(target_os = "solana")]
    unsafe {
        pinocchio::syscalls::sol_sha256(
            parts as *const _ as *const u8,
            parts.len() as u64,
            out.as_mut_ptr(),
        );
    }
    #[cfg(not(target_os = "solana"))]
    {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        for p in parts {
            h.update(p);
        }
        out.copy_from_slice(&h.finalize());
    }
    out
}

/// One step of chain `chain` at position `step`. The (seed, chain, step)
/// tweak makes every hash call unique, which blocks multi-target attacks
/// across chains, positions and keys.
#[inline(always)]
pub fn chain_step(seed: &[u8; SEED_LEN], chain: u8, step: u8, x: &[u8; N]) -> [u8; N] {
    take(&hashv(&[DOMAIN_CHAIN, seed, &[chain, step], x]), 0)
}

/// Applies steps `from..to` of a chain.
#[inline(always)]
pub fn chain(seed: &[u8; SEED_LEN], chain: u8, from: u8, to: u8, x: &[u8; N]) -> [u8; N] {
    let mut v = *x;
    let mut s = from;
    while s < to {
        v = chain_step(seed, chain, s, &v);
        s += 1;
    }
    v
}

/// Splits a message digest into the 26 chain digits (24 message + 2 checksum).
pub fn digits(digest: &[u8; MSG_DIGITS]) -> [u8; CHAINS] {
    let mut d = [0u8; CHAINS];
    let mut csum: u16 = 0;
    let mut i = 0;
    while i < MSG_DIGITS {
        d[i] = digest[i];
        csum += (MAX_STEP - digest[i]) as u16;
        i += 1;
    }
    d[MSG_DIGITS] = (csum >> 8) as u8;
    d[MSG_DIGITS + 1] = (csum & 0xff) as u8;
    d
}

/// Recomputes the 32-byte public key commitment from a signature. A valid
/// signature for `digest` reproduces the commitment of the signing key; any
/// other input yields an unrelated value.
pub fn recover_pk_hash(
    seed: &[u8; SEED_LEN],
    digest: &[u8; MSG_DIGITS],
    sig: &[u8; SIG_LEN],
) -> [u8; 32] {
    let d = digits(digest);
    let mut ends = [0u8; SIG_LEN];
    let mut i = 0;
    while i < CHAINS {
        let end = chain(seed, i as u8, d[i], MAX_STEP, &take(sig, i * N));
        put(&mut ends, i * N, &end);
        i += 1;
    }
    hashv(&[DOMAIN_PK, seed, &ends])
}

/// Off-chain key material. Never used by the program.
#[cfg(not(target_os = "solana"))]
pub mod keys {
    use super::*;

    /// Derives chain start values from a 32-byte master secret.
    pub fn secret_chain(master: &[u8; 32], i: u8) -> [u8; N] {
        take(&hashv(&[DOMAIN_SK, master, &[i]]), 0)
    }

    pub fn public_key_hash(master: &[u8; 32], seed: &[u8; SEED_LEN]) -> [u8; 32] {
        let mut ends = [0u8; SIG_LEN];
        for i in 0..CHAINS {
            let end = chain(seed, i as u8, 0, MAX_STEP, &secret_chain(master, i as u8));
            put(&mut ends, i * N, &end);
        }
        hashv(&[DOMAIN_PK, seed, &ends])
    }

    pub fn sign(master: &[u8; 32], seed: &[u8; SEED_LEN], digest: &[u8; MSG_DIGITS]) -> [u8; SIG_LEN] {
        let d = digits(digest);
        let mut sig = [0u8; SIG_LEN];
        for i in 0..CHAINS {
            let v = chain(seed, i as u8, 0, d[i], &secret_chain(master, i as u8));
            put(&mut sig, i * N, &v);
        }
        sig
    }
}
