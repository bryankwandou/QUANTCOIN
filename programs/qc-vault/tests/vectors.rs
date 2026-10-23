//! The on-chain program's own WOTS, digest and PDA code must reproduce
//! audit/test-vectors.txt (written by client/vectors.ts) byte for byte. The web
//! and Android apps check the same file, so a signature made by any client is the
//! one this program verifies.
use qc_vault::{spend_digest, wots, VAULT_SEED};
use solana_address::Address;

const T22: Address = Address::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA: Address = Address::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const PROGRAM: Address = Address::from_str_const("CiupyGrAtWomKW5rDWbaMEsm3Db8pY8NPECgL2FfACms");

fn unhex(s: &str) -> Vec<u8> {
    assert!(s.len() % 2 == 0, "odd hex length");
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex")).collect()
}

fn arr<const L: usize>(s: &str) -> [u8; L] {
    unhex(s).try_into().unwrap_or_else(|v: Vec<u8>| panic!("expected {L} bytes, got {}", v.len()))
}

#[test]
fn program_code_matches_shared_test_vectors() {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../audit/test-vectors.txt"))
        .expect("audit/test-vectors.txt");
    let mut seen = std::collections::BTreeMap::<&str, usize>::new();
    for line in text.lines().filter(|l| !l.starts_with('#') && !l.is_empty()) {
        let f: Vec<&str> = line.split(' ').collect();
        match f[0] {
            "pk" => assert_eq!(wots::keys::public_key_hash(&arr(f[1]), &arr(f[2])), arr::<32>(f[3]), "{line}"),
            "sig" => {
                let (master, seed, digest) = (arr(f[1]), arr(f[2]), arr(f[3]));
                let d = wots::digits(&digest);
                assert_eq!((d[24].to_string(), d[25].to_string()), (f[4].to_string(), f[5].to_string()), "checksum {line}");
                let sig = arr(f[6]);
                assert_eq!(wots::keys::sign(&master, &seed, &digest), sig, "signature {}", &line[..120]);
                // The verifier the program runs accepts the client's signature.
                assert_eq!(wots::recover_pk_hash(&seed, &digest, &sig), wots::keys::public_key_hash(&master, &seed));
            }
            "digest" => {
                let amount: u64 = f[7].parse().unwrap();
                let got = spend_digest(&arr(f[1]), &arr(f[2]), &arr(f[3]), &arr(f[4]), &arr(f[5]), &arr(f[6]), amount);
                assert_eq!(got, arr::<24>(f[8]), "{line}");
                assert_eq!(arr::<32>(f[1]), PROGRAM.to_bytes(), "vectors use the mainnet program id");
            }
            "pda" => {
                let pk = wots::keys::public_key_hash(&arr(f[1]), &arr(f[2]));
                let (pda, bump) = Address::find_program_address(&[VAULT_SEED, &pk, &unhex(f[4])], &PROGRAM);
                assert_eq!((pda.to_bytes(), bump.to_string()), (arr::<32>(f[5]), f[6].to_string()), "{line}");
            }
            "ata" => {
                let (ta, _) = Address::find_program_address(&[&unhex(f[1]), T22.as_ref(), &unhex(f[2])], &ATA);
                assert_eq!(ta.to_bytes(), arr::<32>(f[3]), "{line}");
            }
            k => panic!("unknown vector kind {k}"),
        }
        *seen.entry(f[0]).or_default() += 1;
    }
    let want = [("ata", 3), ("digest", 4), ("pda", 3), ("pk", 3), ("sig", 9)];
    assert_eq!(seen.into_iter().collect::<Vec<_>>(), want, "vector file is incomplete");
}
