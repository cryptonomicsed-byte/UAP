//! M1-07 (V6-05-09): the committed golden fixtures are verified by the Rust kernel and
//! by three independent implementations (Python, Go, Elixir), and every language must
//! rebuild byte-identical canonical JSON.
//!
//! A portability claim that is only tested in Rust is not a portability claim. These
//! tests refuse to pass when a fixture drifts, when a serializer diverges, or when a
//! verifier accepts a document it should reject.

use std::path::{Path, PathBuf};
use std::process::Command;

use agentos_policy::fixtures::{check_dir, expected, verify_dir};

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures")
}

fn fixture_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(fixtures_dir())
        .expect("fixtures dir")
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    dirs
}

fn sha_from_stdout(stdout: &str) -> Option<String> {
    let idx = stdout.find("sha256=")?;
    let rest = &stdout[idx + "sha256=".len()..];
    let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    let value = &rest[..end];
    if value == "-" {
        None
    } else {
        Some(value.to_string())
    }
}

#[test]
fn there_are_five_fixtures_and_each_meets_its_expectation() {
    let dirs = fixture_dirs();
    assert_eq!(
        dirs.len(),
        5,
        "expected 5 committed fixtures, found {dirs:?}"
    );
    for dir in &dirs {
        let outcome = check_dir(dir).unwrap_or_else(|e| panic!("{}: {e}", dir.display()));
        assert!(outcome.canonical_sha256.is_some() || !expected(dir).unwrap());
    }
}

#[test]
fn the_three_invalid_fixtures_are_invalid_for_the_right_reason() {
    let cases = [
        ("lease-0002-tampered", "signature"),
        ("lease-0004-badsig", "signature"),
        ("lease-0005-unknown-field", "schema"),
    ];
    for (name, needle) in cases {
        let outcome = verify_dir(&fixtures_dir().join(name));
        assert!(!outcome.verified, "{name} must not verify");
        assert!(
            outcome.reason.contains(needle),
            "{name}: reason {:?} does not mention {needle:?}",
            outcome.reason
        );
    }
}

#[test]
fn minting_is_deterministic_and_matches_the_committed_fixtures() {
    // Re-run the minting tool into a scratch dir: every byte must match what is
    // committed, or the "golden" fixtures have been hand-edited.
    let scratch = std::env::temp_dir().join(format!("uap-fixtures-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&scratch);
    let status = Command::new(env!("CARGO_BIN_EXE_mint-fixtures"))
        .arg(&scratch)
        .status()
        .expect("run mint-fixtures");
    assert!(status.success(), "mint-fixtures failed");

    for dir in fixture_dirs() {
        let name = dir.file_name().unwrap();
        for file in [
            "fields.json",
            "canonical.sha256",
            "sig.hex",
            "issuer.pub.hex",
            "expect.txt",
        ] {
            let committed = std::fs::read(dir.join(file)).expect("committed");
            let minted = std::fs::read(scratch.join(name).join(file)).expect("minted");
            assert_eq!(
                committed,
                minted,
                "{}/{} differs from a fresh mint",
                name.to_string_lossy(),
                file
            );
        }
    }
    let _ = std::fs::remove_dir_all(&scratch);
}

#[test]
fn the_rust_verifier_binary_agrees_with_the_library() {
    let bin = env!("CARGO_BIN_EXE_verify-lease");
    for dir in fixture_dirs() {
        let out = Command::new(bin)
            .arg(&dir)
            .output()
            .expect("run verify-lease");
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        assert!(out.status.success(), "{}: {}", dir.display(), stdout);
        let lib = verify_dir(&dir);
        assert_eq!(
            sha_from_stdout(&stdout),
            lib.canonical_sha256,
            "binary and library disagree on canonical bytes for {}",
            dir.display()
        );
    }
}

/// Run one external verifier for every fixture and assert (a) it exits 0 (conclusion
/// matched expect.txt) and (b) its canonical sha256 equals the Rust one.
fn check_external(lang: &str, program: &str, args: &[&str]) {
    let rust_shas: Vec<Option<String>> = fixture_dirs()
        .iter()
        .map(|d| verify_dir(d).canonical_sha256)
        .collect();

    for (i, dir) in fixture_dirs().iter().enumerate() {
        let out = Command::new(program)
            .args(args)
            .arg(dir)
            .output()
            .unwrap_or_else(|e| panic!("spawn {lang}: {e}"));
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        assert!(
            out.status.success(),
            "{lang} disagreed on {}: status={:?} stdout={} stderr={}",
            dir.display(),
            out.status.code(),
            stdout,
            String::from_utf8_lossy(&out.stderr)
        );
        if let Some(sha) = sha_from_stdout(&stdout) {
            assert_eq!(
                Some(sha),
                rust_shas[i],
                "{lang} rebuilt different canonical bytes for {}",
                dir.display()
            );
        }
    }
    eprintln!("{lang}: 5/5 fixtures verified with identical canonical bytes");
}

#[test]
fn the_python_verifier_agrees() {
    let script = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/verify-lease.py")
        .to_path_buf();
    let script = std::fs::canonicalize(&script).expect("scripts/verify-lease.py");
    check_external("python", "python3", &[script.to_str().unwrap()]);
}

#[test]
fn the_go_verifier_agrees_if_go_is_installed() {
    if Command::new("go").arg("version").output().is_err() {
        eprintln!("go: skipped (no toolchain) — CI runs scripts/portable-lease-check.sh with REQUIRE_ALL=1");
        return;
    }
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("verifiers/go");
    let bin = std::env::temp_dir().join(format!("uap-verify-lease-go-{}", std::process::id()));
    let build = Command::new("go")
        .args(["build", "-o"])
        .arg(&bin)
        .arg(".")
        .current_dir(&src)
        .output()
        .expect("go build");
    assert!(
        build.status.success(),
        "go build: {}",
        String::from_utf8_lossy(&build.stderr)
    );
    check_external("go", bin.to_str().unwrap(), &[]);
    let _ = std::fs::remove_file(bin);
}

#[test]
fn the_elixir_verifier_agrees_if_elixir_is_installed() {
    if Command::new("elixir").arg("--version").output().is_err() {
        eprintln!("elixir: skipped (no toolchain) — CI runs scripts/portable-lease-check.sh with REQUIRE_ALL=1");
        return;
    }
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("verifiers/verify_lease.exs");
    check_external("elixir", "elixir", &[script.to_str().unwrap()]);
}

#[test]
fn the_fixture_issuer_key_is_the_published_seed_not_a_secret() {
    // Documented, testable: the fixture key is seed [7u8; 32]. If someone swaps in a
    // real key, this fails and the fixtures are no longer publishable.
    let key = agentos_policy::signature::SigningKeyPair::from_seed(&[7u8; 32]);
    let committed = std::fs::read_to_string(fixtures_dir().join("lease-0001/issuer.pub.hex"))
        .expect("issuer.pub.hex");
    assert_eq!(committed.trim(), key.public_key_hex());
    // And the digest in the fixture is the digest of its own canonical bytes.
    let fixture = fixtures_dir().join("lease-0001");
    let outcome = verify_dir(&fixture);
    assert!(outcome.verified, "{}", outcome.reason);
    let committed = std::fs::read_to_string(fixture.join("canonical.sha256")).unwrap();
    assert_eq!(outcome.canonical_sha256.as_deref(), Some(committed.trim()));
}
