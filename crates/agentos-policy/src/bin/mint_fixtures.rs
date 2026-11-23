//! Regenerate the committed golden lease fixtures (V6-05-09).
//!
//! Usage: `mint-fixtures [output-dir]` (default `crates/agentos-policy/fixtures`).
//!
//! The output is deterministic: the signing key is the published fixture seed
//! `[7u8; 32]`, every digest is derived from a fixed string, and no clock is read. Re-running
//! this must produce byte-identical files — `git status` after a run is the check.
//!
//! The five fixtures cover the ways a portable verifier can be wrong:
//! valid, tampered field (signature must catch it), foreign tenant (no hardcoding),
//! corrupted signature, and an unknown field (strict schema, not lenient JSON).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use agentos_policy::ids::{Digest, RefId, Sid, TenantId};
use agentos_policy::lease::{RevocationRef, SignedLease, TaskLease};
use agentos_policy::signature::SigningKeyPair;

/// Published fixture key. Not a secret: it only ever signs test vectors.
const FIXTURE_SEED: [u8; 32] = [7u8; 32];

fn lease(tenant: &str, sid: &str, epoch: u64, expires_at_ms: u64) -> TaskLease {
    TaskLease {
        lease_id: RefId::parse("lease-0001").unwrap(),
        task_id: RefId::parse("task-0001").unwrap(),
        tenant: TenantId::parse(tenant).unwrap(),
        sid: Sid::parse(sid).unwrap(),
        role_digest: Digest::of(b"role:frontend@1"),
        grant_id: RefId::parse("grant-0001").unwrap(),
        epoch,
        issued_at_ms: 1_700_000_000_000,
        expires_at_ms,
        revocation: RevocationRef {
            list: RefId::parse("tenant-acme-revocations").unwrap(),
            version: 12,
        },
        nonce: Digest::of(b"nonce:0001"),
    }
}

fn fields_json(l: &TaskLease) -> String {
    format!(
        concat!(
            "{{\n",
            "  \"v\": \"uap-lease/1\",\n",
            "  \"lease_id\": \"{}\",\n",
            "  \"task_id\": \"{}\",\n",
            "  \"tenant\": \"{}\",\n",
            "  \"sid\": \"{}\",\n",
            "  \"role_digest\": \"{}\",\n",
            "  \"grant_id\": \"{}\",\n",
            "  \"epoch\": {},\n",
            "  \"issued_at_ms\": {},\n",
            "  \"expires_at_ms\": {},\n",
            "  \"revocation\": {{\n",
            "    \"list\": \"{}\",\n",
            "    \"version\": {}\n",
            "  }},\n",
            "  \"nonce\": \"{}\"\n",
            "}}\n"
        ),
        l.lease_id,
        l.task_id,
        l.tenant,
        l.sid,
        l.role_digest.to_hex(),
        l.grant_id,
        l.epoch,
        l.issued_at_ms,
        l.expires_at_ms,
        l.revocation.list,
        l.revocation.version,
        l.nonce.to_hex()
    )
}

fn write_fixture(
    root: &Path,
    name: &str,
    fields: &str,
    canonical: &str,
    sig_hex: &str,
    pub_hex: &str,
    expect_valid: bool,
) {
    let dir = root.join(name);
    fs::create_dir_all(&dir).expect("create fixture dir");
    fs::write(dir.join("fields.json"), fields).expect("fields.json");
    fs::write(
        dir.join("canonical.sha256"),
        format!("{}\n", Digest::of(canonical.as_bytes()).to_hex()),
    )
    .expect("canonical.sha256");
    fs::write(dir.join("sig.hex"), format!("{sig_hex}\n")).expect("sig.hex");
    fs::write(dir.join("issuer.pub.hex"), format!("{pub_hex}\n")).expect("issuer.pub.hex");
    fs::write(
        dir.join("expect.txt"),
        if expect_valid { "valid\n" } else { "invalid\n" },
    )
    .expect("expect.txt");
}

fn main() -> ExitCode {
    let root = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("crates/agentos-policy/fixtures"));

    let key = SigningKeyPair::from_seed(&FIXTURE_SEED);
    let pub_hex = key.public_key_hex();

    // 1. Valid lease.
    let base = lease("acme", "sid_0a1b2c3d", 3, 1_700_000_060_000);
    let base_sig = SignedLease::sign(base.clone(), "issuer-acme".parse().unwrap(), &key);
    write_fixture(
        &root,
        "lease-0001",
        &fields_json(&base),
        &base.canonical_json(),
        &base_sig.signature.to_hex(),
        &pub_hex,
        true,
    );

    // 2. One field changed after signing: the canonical bytes rebuild cleanly and the
    //    hash matches, so only signature verification can catch it.
    let mut tampered = base.clone();
    tampered.expires_at_ms += 1;
    write_fixture(
        &root,
        "lease-0002-tampered",
        &fields_json(&tampered),
        &tampered.canonical_json(),
        &base_sig.signature.to_hex(),
        &pub_hex,
        false,
    );

    // 3. A different tenant/SID, validly signed: nothing may be hardcoded.
    let foreign = lease("globex", "sid_ffff0000", 7, 1_700_000_120_000);
    let foreign_sig = SignedLease::sign(foreign.clone(), "issuer-acme".parse().unwrap(), &key);
    write_fixture(
        &root,
        "lease-0003-foreign",
        &fields_json(&foreign),
        &foreign.canonical_json(),
        &foreign_sig.signature.to_hex(),
        &pub_hex,
        true,
    );

    // 4. Corrupted signature: correct document, byte flipped.
    let mut bad = base_sig.signature.to_bytes();
    bad[0] ^= 0xff;
    write_fixture(
        &root,
        "lease-0004-badsig",
        &fields_json(&base),
        &base.canonical_json(),
        &agentos_policy::signature::Signature::from_bytes(bad).to_hex(),
        &pub_hex,
        false,
    );

    // 5. Unknown field: a strict verifier rejects the document before any crypto.
    //    Inserted as the last member (so the JSON stays well-formed) to prove the
    //    rejection is schema strictness, not a parse error.
    let base_fields = fields_json(&base);
    let body = base_fields.trim_end().trim_end_matches('}').trim_end();
    let unknown = format!("{body},\n  \"admin\": true\n}}\n");
    write_fixture(
        &root,
        "lease-0005-unknown-field",
        &unknown,
        &base.canonical_json(),
        &base_sig.signature.to_hex(),
        &pub_hex,
        false,
    );

    println!("minted 5 fixtures under {}", root.display());
    ExitCode::SUCCESS
}
