//! Host-side property tests for `src/wots.rs` (WOTS, w = 256, n = 24 bytes).
//!
//! No external property-testing crate: `proptest` is not in the local cargo
//! cache and this review runs offline, so (like `tests/fuzz.rs`) a seeded
//! splitmix64 PRNG drives every property. Runs are reproducible:
//!   QC_PROP_SEED=<u64>   change the master seed (printed by every test)
//!   QC_PROP_CASES=<n>    base case count per property (default 10_000)
//!
//! Only `wots::*` and `spend_digest` are exercised; nothing here needs the
//! deployed `.so`, so `cargo test --test wots_props` runs on a bare host.
//!
//! Properties:
//!   p01  sign -> recover_pk_hash round-trip equals public_key_hash
//!   p02  checksum non-domination (exhaustive over checksum values + random
//!        and adversarial near-max digests)
//!   p03  digit / checksum bounds (26 digits, checksum <= 6120)
//!   p04  domain separation, seed / master / tweak binding into pk_hash
//!   p05  any single-byte signature tamper changes the recovered pk_hash
//!   p06  chain composition chain(b..e, chain(a..b, x)) == chain(a..e, x)
//!        plus the forward-walk forgery attempt that the checksum must stop
use qc_vault::wots::{self, keys, CHAINS, CSUM_DIGITS, MAX_STEP, MSG_DIGITS, N, SEED_LEN, SIG_LEN};
use qc_vault::{spend_digest, SPEND_DATA_LEN};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::time::Instant;

// ---------------------------------------------------------------------
// Deterministic PRNG and case counts
// ---------------------------------------------------------------------

struct Rng(u64);
impl Rng {
    fn new(test: &str, salt: u64) -> Self {
        let s = std::env::var("QC_PROP_SEED").ok().and_then(|v| v.parse().ok()).unwrap_or(0x51C0_DE5E_ED00_2026u64);
        println!("[{test}] QC_PROP_SEED={s} salt={salt}");
        Rng(s ^ salt.wrapping_mul(0x9E37_79B9_7F4A_7C15))
    }
    /// splitmix64
    fn u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// Uniform-ish in 0..n (multiply-shift; bias < 2^-50 for our n).
    fn below(&mut self, n: u64) -> u64 { ((self.u64() as u128 * n as u128) >> 64) as u64 }
    /// Inclusive range.
    fn range(&mut self, lo: u64, hi: u64) -> u64 { lo + self.below(hi - lo + 1) }
    fn u8_in(&mut self, lo: u8, hi: u8) -> u8 { self.range(lo as u64, hi as u64) as u8 }
    fn arr<const L: usize>(&mut self) -> [u8; L] {
        let mut a = [0u8; L];
        for x in a.iter_mut() { *x = self.u64() as u8; }
        a
    }
    fn coin(&mut self, one_in: u64) -> bool { self.below(one_in) == 0 }
}

fn cases() -> usize {
    std::env::var("QC_PROP_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(10_000)
}

fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{x:02x}")).collect() }

// ---------------------------------------------------------------------
// Reference helpers (independent of wots.rs internals)
// ---------------------------------------------------------------------

fn sha(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts { h.update(p); }
    h.finalize().into()
}
fn trunc(h: [u8; 32]) -> [u8; N] { h[..N].try_into().unwrap() }

/// Spec checksum: sum of (255 - digit) over the 24 message digits.
fn csum_of(d: &[u8; MSG_DIGITS]) -> u32 { d.iter().map(|&x| (MAX_STEP - x) as u32).sum() }

/// `hi` reveals enough to compute `lo` by walking chains forward
/// (digit-wise hi >= lo): the WOTS forgery condition.
fn dominates(hi: &[u8; CHAINS], lo: &[u8; CHAINS]) -> bool { hi.iter().zip(lo).all(|(h, l)| h >= l) }

/// A digest whose checksum is exactly `target` (0..=6120), with the deficit
/// spread randomly over the 24 positions.
fn digest_with_csum(rng: &mut Rng, target: u32) -> [u8; MSG_DIGITS] {
    assert!(target <= 24 * 255);
    let mut order: Vec<usize> = (0..MSG_DIGITS).collect();
    for i in (1..order.len()).rev() { order.swap(i, rng.below(i as u64 + 1) as usize); }
    let mut d = [MAX_STEP; MSG_DIGITS];
    let mut rem = target;
    for (k, &i) in order.iter().enumerate() {
        let left_after = (MSG_DIGITS - 1 - k) as u32;
        let lo = rem.saturating_sub(255 * left_after);
        let hi = rem.min(255);
        let take = rng.range(lo as u64, hi as u64) as u32;
        d[i] = MAX_STEP - take as u8;
        rem -= take;
    }
    assert_eq!(rem, 0);
    assert_eq!(csum_of(&d), target);
    d
}

/// Mix of uniform and adversarial digests.
fn gen_digest(rng: &mut Rng) -> [u8; MSG_DIGITS] {
    match rng.below(9) {
        0 | 1 => rng.arr(),
        // near-max digits: checksum close to 0, checksum chains revealed deep
        2 => { let mut d = [0u8; MSG_DIGITS]; for x in d.iter_mut() { *x = rng.u8_in(250, 255); } d }
        // near-min digits: checksum close to the 6120 maximum
        3 => { let mut d = [0u8; MSG_DIGITS]; for x in d.iter_mut() { *x = rng.u8_in(0, 5); } d }
        // all 0xff but one position
        4 => { let mut d = [MAX_STEP; MSG_DIGITS]; d[rng.below(24) as usize] = rng.u64() as u8; d }
        // constant digest
        5 => [rng.u64() as u8; MSG_DIGITS],
        // checksum sitting on a byte boundary of the 2-digit encoding
        6 => {
            const EDGES: [u32; 12] = [0, 1, 255, 256, 257, 511, 512, 5887, 5888, 6119, 6120, 6000];
            let t = if rng.coin(2) { EDGES[rng.below(EDGES.len() as u64) as usize] }
                    else { (rng.range(0, 23) as u32 * 256 + if rng.coin(2) { 0 } else { 255 }).min(6120) };
            digest_with_csum(rng, t)
        }
        // realistic: the program's spend digest over random accounts
        7 => spend_digest(&rng.arr(), &rng.arr(), &rng.arr(), &rng.arr(), &rng.arr(), &rng.arr(), rng.u64()),
        // sparse 0x00 / 0xff bytes
        _ => { let mut d: [u8; MSG_DIGITS] = rng.arr(); for x in d.iter_mut() { if rng.coin(3) { *x = if rng.coin(2) { 0 } else { 255 }; } } d }
    }
}

struct Key { master: [u8; 32], seed: [u8; SEED_LEN], pk: [u8; 32] }
fn gen_key(rng: &mut Rng) -> Key {
    let (master, seed) = (rng.arr(), rng.arr());
    Key { master, seed, pk: keys::public_key_hash(&master, &seed) }
}

// =====================================================================
// p01 sign -> recover round-trip
// =====================================================================

/// For random (master, seed) and random/adversarial digests,
/// `recover_pk_hash(seed, digest, sign(master, seed, digest))` equals
/// `public_key_hash(master, seed)`. A key is reused for several digests
/// here ONLY to keep runtime down: the round-trip is per-signature and does
/// not depend on one-time use.
#[test]
fn p01_sign_recover_roundtrip() {
    let t = Instant::now();
    let mut rng = Rng::new("p01", 1);
    const PER_KEY: usize = 8;
    let n = cases();
    let mut done = 0usize;
    // Fixed corner digests first, then random.
    let corners: Vec<[u8; MSG_DIGITS]> = vec![
        [0; MSG_DIGITS], [MAX_STEP; MSG_DIGITS], [1; MSG_DIGITS], [254; MSG_DIGITS],
        { let mut d = [MAX_STEP; MSG_DIGITS]; d[0] = 0; d },
        { let mut d = [0; MSG_DIGITS]; d[23] = MAX_STEP; d },
    ];
    let k = gen_key(&mut rng);
    for d in &corners {
        let sig = keys::sign(&k.master, &k.seed, d);
        assert_eq!(wots::recover_pk_hash(&k.seed, d, &sig), k.pk, "corner digest {}", hex(d));
        done += 1;
    }
    while done < n {
        let k = gen_key(&mut rng);
        for _ in 0..PER_KEY {
            let d = gen_digest(&mut rng);
            let sig = keys::sign(&k.master, &k.seed, &d);
            assert_eq!(sig.len(), SIG_LEN);
            let got = wots::recover_pk_hash(&k.seed, &d, &sig);
            assert_eq!(got, k.pk, "round-trip failed: master={} seed={} digest={}", hex(&k.master), hex(&k.seed), hex(&d));
            done += 1;
        }
    }
    println!("[p01] cases={done} elapsed={:.1?}", t.elapsed());
}

// =====================================================================
// p02 checksum non-domination
// =====================================================================

/// For any distinct digests a != b, digits(b) is strictly smaller than
/// digits(a) in at least one of the 26 positions (and vice versa), so a
/// signature on a can never be walked forward into a signature on b.
#[test]
fn p02_checksum_non_domination() {
    let t = Instant::now();
    let mut rng = Rng::new("p02", 2);
    let mut checked: u64 = 0;

    // (a) EXHAUSTIVE over the checksum encoding. For every checksum value
    //     c in 0..=6120 build a real digest with that checksum, take the two
    //     checksum digits from wots::digits, and check every pair c_b < c_a:
    //     the encoding of the smaller checksum must be strictly lower in some
    //     digit. Message-digit domination (b >= a digit-wise, b != a) forces
    //     csum(b) < csum(a), so (a) covers every possible domination attempt.
    let max_c = (MSG_DIGITS as u32) * (MAX_STEP as u32);
    let mut enc = Vec::with_capacity(max_c as usize + 1);
    for c in 0..=max_c {
        let d = digest_with_csum(&mut rng, c);
        let g = wots::digits(&d);
        assert_eq!(&g[..MSG_DIGITS], &d[..]);
        assert_eq!(((g[24] as u32) << 8) | g[25] as u32, c, "checksum encoding wrong for c={c}");
        enc.push((g[24], g[25]));
    }
    for ca in 0..=max_c as usize {
        let (ha, la) = enc[ca];
        for cb in 0..ca {
            let (hb, lb) = enc[cb];
            assert!(hb < ha || lb < la, "encoding of csum {cb} dominates {ca}");
            checked += 1;
        }
    }
    println!("[p02] exhaustive checksum pairs checked={checked}");

    // (b) Random distinct pairs, both directions.
    let n = cases() * 10;
    for _ in 0..n {
        let a = gen_digest(&mut rng);
        let b = gen_digest(&mut rng);
        if a == b { continue; }
        let (da, db) = (wots::digits(&a), wots::digits(&b));
        assert!(!dominates(&db, &da), "forgery a->b possible: a={} b={}", hex(&a), hex(&b));
        assert!(!dominates(&da, &db), "forgery b->a possible: a={} b={}", hex(&a), hex(&b));
    }

    // (c) Message-part domination by construction: raise a random non-empty
    //     subset of a's digits. Some CHECKSUM digit must strictly decrease.
    for _ in 0..n {
        let a = gen_digest(&mut rng);
        let mut b = a;
        for i in 0..MSG_DIGITS { if rng.coin(4) { b[i] = b[i].saturating_add(rng.u8_in(1, 255)); } }
        if b == a { let i = rng.below(24) as usize; if a[i] < MAX_STEP { b[i] += 1; } else { continue; } }
        let (da, db) = (wots::digits(&a), wots::digits(&b));
        assert!(db[..MSG_DIGITS].iter().zip(&da[..MSG_DIGITS]).all(|(x, y)| x >= y));
        assert!(db[24] < da[24] || db[25] < da[25], "checksum did not drop: a={} b={}", hex(&a), hex(&b));
    }

    // (d) Adversarial near-max digits: a has every digit in 250..=255 (tiny
    //     checksum), b raises exactly ONE digit by the smallest step (+1).
    //     This is the cheapest possible forgery attempt (delta = 1).
    for _ in 0..n {
        let mut a = [0u8; MSG_DIGITS];
        for x in a.iter_mut() { *x = rng.u8_in(250, 255); }
        let room: Vec<usize> = (0..MSG_DIGITS).filter(|&i| a[i] < MAX_STEP).collect();
        if room.is_empty() { continue; }
        let mut b = a;
        b[room[rng.below(room.len() as u64) as usize]] += 1;
        let (da, db) = (wots::digits(&a), wots::digits(&b));
        assert!(!dominates(&db, &da), "near-max +1 forgery: a={} b={}", hex(&a), hex(&b));
    }

    // (e) Byte-boundary attack: csum(a) = 256*h exactly (low digit 0), so a
    //     +delta raise wraps the low digit to 256 - delta (it goes UP). The
    //     high digit must then drop. Checked for every h and delta 1..=255.
    for h in 1..=23u32 {
        for delta in 1..=255u32 {
            let a = digest_with_csum(&mut rng, 256 * h);
            // spread +delta over positions with headroom
            let mut b = a;
            let mut left = delta;
            while left > 0 {
                let i = rng.below(24) as usize;
                let room = (MAX_STEP - b[i]) as u32;
                if room == 0 { continue; }
                let step = rng.range(1, room.min(left) as u64) as u32;
                b[i] += step as u8;
                left -= step;
            }
            let (da, db) = (wots::digits(&a), wots::digits(&b));
            assert_eq!(da[25], 0);
            assert_eq!(db[24], da[24] - 1, "high checksum digit must drop at h={h} delta={delta}");
            assert_eq!(db[25] as u32, 256 - delta);
            assert!(!dominates(&db, &da));
            checked += 1;
        }
    }

    // (f) "Keep the high digit" attack: raise by delta <= low digit so the
    //     high digit is unchanged; then the low digit must drop by delta.
    for _ in 0..n {
        let a = gen_digest(&mut rng);
        let da = wots::digits(&a);
        let headroom: u32 = a.iter().map(|&x| (MAX_STEP - x) as u32).sum();
        let cap = (da[25] as u32).min(headroom);
        if cap == 0 { continue; }
        let delta = rng.range(1, cap as u64) as u32;
        let mut b = a;
        let mut left = delta;
        while left > 0 {
            let i = rng.below(24) as usize;
            if b[i] == MAX_STEP { continue; }
            b[i] += 1;
            left -= 1;
        }
        let db = wots::digits(&b);
        assert_eq!(db[24], da[24]);
        assert_eq!(db[25] as u32, da[25] as u32 - delta);
    }

    println!("[p02] random/adversarial pairs={} boundary+exhaustive checks={checked}, elapsed={:.1?}", 4 * n, t.elapsed());
}

// =====================================================================
// p03 digit / checksum bounds
// =====================================================================

#[test]
fn p03_digit_and_checksum_bounds() {
    let t = Instant::now();
    let mut rng = Rng::new("p03", 3);

    // Layout constants the program and clients rely on.
    assert_eq!(N, 24);
    assert_eq!(MSG_DIGITS, 24);
    assert_eq!(CSUM_DIGITS, 2);
    assert_eq!(CHAINS, 26);
    assert_eq!(SIG_LEN, 26 * 24);
    assert_eq!(SIG_LEN, 624);
    assert_eq!(MAX_STEP, 255);
    assert_eq!(SEED_LEN, 16);
    assert_eq!(SPEND_DATA_LEN, 26 + SIG_LEN);
    // The checksum fits its digits and the u16 accumulator.
    let max_c = MSG_DIGITS as u32 * MAX_STEP as u32;
    assert_eq!(max_c, 6120);
    assert!(max_c < 1u32 << (8 * CSUM_DIGITS));
    assert!(max_c <= u16::MAX as u32);
    assert_eq!(max_c >> 8, 23);
    assert_eq!(max_c & 0xff, 232);

    // Extremes.
    assert_eq!(wots::digits(&[0; MSG_DIGITS])[24..], [23, 232]);
    assert_eq!(wots::digits(&[MAX_STEP; MSG_DIGITS])[24..], [0, 0]);

    let check = |d: &[u8; MSG_DIGITS]| -> u32 {
        let g = wots::digits(d);
        assert_eq!(g.len(), 26);
        assert_eq!(&g[..MSG_DIGITS], &d[..], "message digits must equal digest bytes");
        let c = ((g[24] as u32) << 8) | g[25] as u32;
        assert_eq!(c, csum_of(d), "checksum mismatch for {}", hex(d));
        assert!(c <= 6120);
        assert!(g[24] <= 23);
        if g[24] == 23 { assert!(g[25] <= 232); }
        // verifier work (hash steps in recover_pk_hash) is bounded
        let steps: u32 = g.iter().map(|&x| (MAX_STEP - x) as u32).sum();
        assert!(steps <= 6375, "steps {steps} for {}", hex(d));
        c
    };

    // Every checksum value is reachable and encoded exactly.
    for c in 0..=max_c { assert_eq!(check(&digest_with_csum(&mut rng, c)), c); }
    // Random and adversarial digests.
    let n = cases() * 10;
    let mut max_seen = 0;
    for _ in 0..n { max_seen = max_seen.max(check(&gen_digest(&mut rng))); }
    println!("[p03] exhaustive csum values={} random={} max_csum_seen={} elapsed={:.1?}", max_c + 1, n, max_seen, t.elapsed());
}

// =====================================================================
// p04 domain separation and seed / master / tweak binding
// =====================================================================

#[test]
fn p04_domain_separation_and_binding() {
    let t = Instant::now();
    let mut rng = Rng::new("p04", 4);
    let tags: [(&str, &[u8]); 4] = [
        ("chain", wots::DOMAIN_CHAIN), ("pk", wots::DOMAIN_PK), ("msg", wots::DOMAIN_MSG), ("sk", wots::DOMAIN_SK),
    ];

    // (a) Tags are pairwise distinct AND prefix-free: then any two hash
    //     inputs from different domains differ inside the shorter tag,
    //     whatever follows. Every input is also fixed length per domain.
    for (i, (na, a)) in tags.iter().enumerate() {
        assert!(a.starts_with(b"QCV1/"), "{na} lacks version prefix");
        for (nb, b) in tags.iter().skip(i + 1) {
            assert_ne!(a, b);
            assert!(!a.starts_with(b) && !b.starts_with(a), "tag {na} / {nb} not prefix-free");
        }
    }
    let lens = [
        wots::DOMAIN_CHAIN.len() + SEED_LEN + 2 + N,          // chain_step
        wots::DOMAIN_PK.len() + SEED_LEN + SIG_LEN,           // pk commitment
        wots::DOMAIN_MSG.len() + 6 * 32 + 8,                  // spend_digest
        wots::DOMAIN_SK.len() + 32 + 1,                       // secret_chain
    ];
    println!("[p04] per-domain preimage lengths chain/pk/msg/sk = {lens:?}");
    for i in 0..4 { for j in i + 1..4 { assert_ne!(lens[i], lens[j]); } }

    let n = cases();
    // (b) Each primitive uses exactly its own tag (matches an independent
    //     SHA-256 recomputation, and differs from every other tag).
    for _ in 0..n {
        let seed: [u8; SEED_LEN] = rng.arr();
        let x: [u8; N] = rng.arr();
        let (c, s) = (rng.below(CHAINS as u64) as u8, rng.u64() as u8);
        let got = wots::chain_step(&seed, c, s, &x);
        assert_eq!(got, trunc(sha(&[wots::DOMAIN_CHAIN, &seed, &[c, s], &x])));
        for &(_, tag) in &tags[1..] { assert_ne!(got, trunc(sha(&[tag, &seed, &[c, s], &x]))); }

        let master: [u8; 32] = rng.arr();
        let sk = keys::secret_chain(&master, c);
        assert_eq!(sk, trunc(sha(&[wots::DOMAIN_SK, &master, &[c]])));
        assert_ne!(sk, trunc(sha(&[wots::DOMAIN_CHAIN, &master, &[c]])));

        let f: [[u8; 32]; 6] = [rng.arr(), rng.arr(), rng.arr(), rng.arr(), rng.arr(), rng.arr()];
        let amt = rng.u64();
        let md = spend_digest(&f[0], &f[1], &f[2], &f[3], &f[4], &f[5], amt);
        assert_eq!(&md[..], &sha(&[wots::DOMAIN_MSG, &f[0], &f[1], &f[2], &f[3], &f[4], &f[5], &amt.to_le_bytes()])[..MSG_DIGITS]);
        // every signed field (6 accounts + amount) is bound: flip one byte
        let field = rng.below(7) as usize;
        let (mut g, mut amt2) = (f, amt);
        if field < 6 { g[field][rng.below(32) as usize] ^= rng.u8_in(1, 255); } else { amt2 ^= (rng.u8_in(1, 255) as u64) << (8 * rng.below(8)); }
        assert_ne!(spend_digest(&g[0], &g[1], &g[2], &g[3], &g[4], &g[5], amt2), md, "field {field} not bound");
    }

    // (c) Tweak binding at the hash level: for one (seed, x), all
    //     26 * 256 (chain, step) tweaks give distinct outputs, and changing
    //     the seed changes every one of them (multi-target separation).
    for _ in 0..4 {
        let seed: [u8; SEED_LEN] = rng.arr();
        let mut seed2 = seed; seed2[rng.below(16) as usize] ^= 1 << rng.below(8);
        let x: [u8; N] = rng.arr();
        let mut seen = HashSet::new();
        for c in 0..CHAINS as u8 {
            for s in 0..=MAX_STEP {
                let v = wots::chain_step(&seed, c, s, &x);
                assert!(seen.insert(v), "tweak collision at chain {c} step {s}");
                assert_ne!(v, wots::chain_step(&seed2, c, s, &x), "seed not bound at chain {c} step {s}");
            }
        }
    }

    // (d) Seed and master binding into pk_hash, and seed binding at
    //     verification time. Each case is a full keygen (~6.6k hashes), so
    //     this sub-property runs cases()/10 keys with 3 checks each.
    let m = (n / 10).max(200);
    for i in 0..m {
        let k = gen_key(&mut rng);
        // independent recomputation of the commitment (seed in chains AND in the final hash)
        if i < 50 {
            let mut ends = Vec::with_capacity(SIG_LEN);
            for c in 0..CHAINS as u8 {
                let mut v = trunc(sha(&[wots::DOMAIN_SK, &k.master, &[c]]));
                for s in 0..MAX_STEP { v = trunc(sha(&[wots::DOMAIN_CHAIN, &k.seed, &[c, s], &v])); }
                ends.extend_from_slice(&v);
            }
            assert_eq!(k.pk, sha(&[wots::DOMAIN_PK, &k.seed, &ends]));
            assert_ne!(k.pk, sha(&[wots::DOMAIN_PK, &ends]), "seed must be hashed into the commitment");
            assert_ne!(k.pk, sha(&[wots::DOMAIN_PK, &[0u8; SEED_LEN], &ends]));
        }
        let mut seed2 = k.seed;
        if rng.coin(2) { seed2[rng.below(16) as usize] ^= 1 << rng.below(8); } else { seed2 = rng.arr(); }
        if seed2 == k.seed { continue; }
        assert_ne!(keys::public_key_hash(&k.master, &seed2), k.pk, "pk_hash ignores seed change");
        let mut master2 = k.master; master2[rng.below(32) as usize] ^= 1 << rng.below(8);
        assert_ne!(keys::public_key_hash(&master2, &k.seed), k.pk, "pk_hash ignores master change");
        let d = gen_digest(&mut rng);
        let sig = keys::sign(&k.master, &k.seed, &d);
        assert_eq!(wots::recover_pk_hash(&k.seed, &d, &sig), k.pk);
        assert_ne!(wots::recover_pk_hash(&seed2, &d, &sig), k.pk, "signature verifies under a different seed");
    }
    println!("[p04] hash-level cases={n} tweak-uniqueness=4x{} key-level cases={m} elapsed={:.1?}", CHAINS * 256, t.elapsed());
}

// =====================================================================
// p05 single-byte signature tamper
// =====================================================================

/// Replacing any one byte of a valid signature with any other value changes
/// the recovered commitment. Exhaustive over all 624 positions for a set of
/// signatures (including adversarial digests where some chains reveal the
/// secret start, digit 0, or the public end, digit 255), plus random
/// (position, value) samples. Swapping two chains' values must fail too.
#[test]
fn p05_single_byte_tamper_changes_pk() {
    let t = Instant::now();
    let mut rng = Rng::new("p05", 5);
    let n = cases();
    let mut done = 0usize;
    let mut sweeps = 0usize;
    let digests: Vec<[u8; MSG_DIGITS]> = vec![
        [MAX_STEP; MSG_DIGITS], // message chains reveal ends, checksum chains reveal secret starts
        [0; MSG_DIGITS],        // message chains reveal secret starts
    ];
    let mut queue = digests.into_iter();
    while done < n {
        let k = gen_key(&mut rng);
        let d = queue.next().unwrap_or_else(|| gen_digest(&mut rng));
        let sig = keys::sign(&k.master, &k.seed, &d);
        assert_eq!(wots::recover_pk_hash(&k.seed, &d, &sig), k.pk);
        if sweeps < 8 {
            // every byte position, random replacement value
            for p in 0..SIG_LEN {
                let mut bad = sig;
                bad[p] ^= rng.u8_in(1, 255);
                assert_ne!(wots::recover_pk_hash(&k.seed, &d, &bad), k.pk,
                    "tamper undetected: pos={p} digest={} seed={}", hex(&d), hex(&k.seed));
                done += 1;
            }
            sweeps += 1;
        } else {
            for _ in 0..64 {
                let p = rng.below(SIG_LEN as u64) as usize;
                let mut bad = sig;
                bad[p] ^= rng.u8_in(1, 255);
                assert_ne!(wots::recover_pk_hash(&k.seed, &d, &bad), k.pk,
                    "tamper undetected: pos={p} digest={} seed={}", hex(&d), hex(&k.seed));
                done += 1;
            }
            // positional binding: swap two distinct chain values
            let (i, j) = (rng.below(26) as usize, rng.below(26) as usize);
            if i != j && sig[i * N..(i + 1) * N] != sig[j * N..(j + 1) * N] {
                let mut bad = sig;
                for b in 0..N { bad.swap(i * N + b, j * N + b); }
                assert_ne!(wots::recover_pk_hash(&k.seed, &d, &bad), k.pk, "chain swap {i}<->{j} undetected");
            }
            // digest tamper with the original signature
            let mut d2 = d; d2[rng.below(24) as usize] ^= rng.u8_in(1, 255);
            assert_ne!(wots::recover_pk_hash(&k.seed, &d2, &sig), k.pk);
        }
    }
    // All 255 replacement values at a few positions (chain 0 first byte,
    // chain 25 last byte) for one signature.
    let k = gen_key(&mut rng);
    let d = gen_digest(&mut rng);
    let sig = keys::sign(&k.master, &k.seed, &d);
    for &p in &[0usize, N - 1, 24 * N, SIG_LEN - 1] {
        for v in 1..=255u8 {
            let mut bad = sig; bad[p] ^= v;
            assert_ne!(wots::recover_pk_hash(&k.seed, &d, &bad), k.pk, "pos {p} xor {v}");
            done += 1;
        }
    }
    println!("[p05] tamper cases={done} (full 624-byte sweeps={sweeps}) elapsed={:.1?}", t.elapsed());
}

// =====================================================================
// p06 chain composition (+ the forgery it would enable without checksum)
// =====================================================================

#[test]
fn p06_chain_composition() {
    let t = Instant::now();
    let mut rng = Rng::new("p06", 6);
    let n = cases();
    let pick = |rng: &mut Rng| -> u8 {
        match rng.below(5) { 0 => 0, 1 => MAX_STEP, 2 => MAX_STEP - 1, _ => rng.u64() as u8 }
    };
    for _ in 0..n {
        let seed: [u8; SEED_LEN] = rng.arr();
        let x: [u8; N] = rng.arr();
        let c = rng.below(CHAINS as u64) as u8;
        let mut v = [pick(&mut rng), pick(&mut rng), pick(&mut rng)];
        v.sort();
        let [a, b, e] = v;
        // positional composition law: steps a..b then b..e == steps a..e
        let lhs = wots::chain(&seed, c, b, e, &wots::chain(&seed, c, a, b, &x));
        assert_eq!(lhs, wots::chain(&seed, c, a, e, &x), "composition failed c={c} a={a} b={b} e={e}");
        // identity and single step
        assert_eq!(wots::chain(&seed, c, a, a, &x), x);
        if a < MAX_STEP { assert_eq!(wots::chain(&seed, c, a, a + 1, &x), wots::chain_step(&seed, c, a, &x)); }
        // degenerate from > to is the identity (documented behaviour; never
        // reached by the program since digits <= 255 = MAX_STEP)
        if e > a { assert_eq!(wots::chain(&seed, c, e, a, &x), x); }
        // NON-positional composition must NOT hold: the step index is in the
        // tweak, so restarting at 0 is a different function.
        let (p, q) = (rng.u8_in(1, 127), rng.u8_in(1, 127));
        let naive = wots::chain(&seed, c, 0, q, &wots::chain(&seed, c, 0, p, &x));
        assert_ne!(naive, wots::chain(&seed, c, 0, p + q, &x), "step index not bound in tweak");
        // chain index is bound: same steps on a different chain differ
        let c2 = (c + 1 + rng.below(CHAINS as u64 - 1) as u8) % CHAINS as u8;
        if e > a { assert_ne!(wots::chain(&seed, c2, a, e, &x), wots::chain(&seed, c, a, e, &x)); }
    }

    // Verification relation per chain: walking a signature value from its
    // digit to the end reaches the key's chain end.
    let m = (n / 10).max(200);
    let mut forge_attempts = 0usize;
    for _ in 0..m {
        let k = gen_key(&mut rng);
        let a = gen_digest(&mut rng);
        let sa = keys::sign(&k.master, &k.seed, &a);
        let da = wots::digits(&a);
        for i in 0..CHAINS {
            let sk = keys::secret_chain(&k.master, i as u8);
            let sv: [u8; N] = sa[i * N..(i + 1) * N].try_into().unwrap();
            assert_eq!(sv, wots::chain(&k.seed, i as u8, 0, da[i], &sk));
            assert_eq!(wots::chain(&k.seed, i as u8, da[i], MAX_STEP, &sv),
                       wots::chain(&k.seed, i as u8, 0, MAX_STEP, &sk));
        }
        // Forward-walk forgery attempt: an attacker holding sig(a) raises
        // some message digits to get b, walks every chain it can forward
        // (db[i] >= da[i]) and leaves the rest. Composition makes every
        // walked chain correct, so only the checksum chain(s) that went DOWN
        // stop the forgery; the result must not verify.
        let mut b = a;
        for j in 0..MSG_DIGITS { if rng.coin(3) { b[j] = b[j].saturating_add(rng.u8_in(1, 40)); } }
        if b == a { continue; }
        let db = wots::digits(&b);
        let mut forged = sa;
        let mut stuck = vec![];
        for i in 0..CHAINS {
            if db[i] >= da[i] {
                let sv: [u8; N] = sa[i * N..(i + 1) * N].try_into().unwrap();
                let w = wots::chain(&k.seed, i as u8, da[i], db[i], &sv);
                forged[i * N..(i + 1) * N].copy_from_slice(&w);
            } else {
                stuck.push(i);
            }
        }
        assert!(!stuck.is_empty(), "every chain walkable: forgery a={} b={}", hex(&a), hex(&b));
        assert!(stuck.iter().all(|&i| i >= MSG_DIGITS), "stuck chain in message part: {stuck:?}");
        // the walked chains equal the honest signature on b
        let sb = keys::sign(&k.master, &k.seed, &b);
        for i in 0..CHAINS { if !stuck.contains(&i) { assert_eq!(forged[i * N..(i + 1) * N], sb[i * N..(i + 1) * N]); } }
        assert_ne!(wots::recover_pk_hash(&k.seed, &b, &forged), k.pk, "forward-walk forgery verified!");
        assert_eq!(wots::recover_pk_hash(&k.seed, &b, &sb), k.pk);
        forge_attempts += 1;
    }
    println!("[p06] composition cases={n} key-level cases={m} forward-walk forgeries refused={forge_attempts} elapsed={:.1?}", t.elapsed());
}
