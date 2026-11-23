//! H-27 (V6-08-01): the shared contract registry and its golden fixtures.
//!
//! The registry is not documentation. It is a checked claim: every contract named in
//! `contracts/v1/manifest.json` must have a live producer in this crate, a schema whose
//! declared fields equal the canonical bytes the producer actually emits, and fixtures
//! that the real producer re-derives byte for byte. A language listed as `implemented`
//! must have a verifier on disk; a language listed as `planned` must not (a stale
//! status is how a registry starts lying about coverage).
//!
//! Every negative test copies the registry into a scratch tree, breaks exactly one
//! thing, and asserts the checker reports that thing. If the checker cannot see a
//! broken fixture, it cannot certify a good one.

use std::path::{Path, PathBuf};
use std::process::Command;

use agentos_policy::contracts::{Registry, Violation};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("crates/agentos-policy has two ancestors")
        .to_path_buf()
}

fn load_clean() -> Registry {
    let reg = Registry::load(&repo_root()).expect("registry loads");
    let violations = reg.check();
    assert!(
        violations.is_empty(),
        "committed registry must be clean, found: {}",
        render(&violations)
    );
    reg
}

fn render(violations: &[Violation]) -> String {
    violations
        .iter()
        .map(|v| format!("[{}] {}", v.code, v.detail))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Copy the paths the registry reads into a scratch tree, so a test can break one
/// file without touching the checkout. Only the files the checker actually reads are
/// copied: a whole-repo copy would pull `node_modules` in.
fn scratch_copy(tag: &str) -> PathBuf {
    let src = repo_root();
    let dst = std::env::temp_dir().join(format!("uap-contracts-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dst);
    std::fs::create_dir_all(&dst).expect("scratch root");
    let paths = [
        "contracts",
        "crates/agentos-policy/src",
        "crates/agentos-policy/fixtures",
        "crates/agentos-policy/verifiers",
        "crates/agentos-policy/tests/authorize_bundle.rs",
        "scripts/verify-lease.py",
    ];
    for rel in paths {
        copy_tree(&src.join(rel), &dst.join(rel));
    }
    dst
}

fn copy_tree(from: &Path, to: &Path) {
    if from.is_file() {
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).expect("parent dir");
        }
        std::fs::copy(from, to).expect("copy file");
        return;
    }
    std::fs::create_dir_all(to).expect("copy dir");
    for entry in std::fs::read_dir(from).expect("read dir") {
        let entry = entry.expect("dir entry");
        copy_tree(&entry.path(), &to.join(entry.file_name()));
    }
}

fn assert_reported(root: &Path, code: &str) {
    let reg = Registry::load(root).expect("registry still parses after the edit");
    let violations = reg.check();
    assert!(
        violations.iter().any(|v| v.code == code),
        "expected a {code:?} violation, got: {}",
        render(&violations)
    );
}

/// A broken fixture must be reported *for the right reason*: a checker that says only
/// "something is wrong with grant-0001" cannot tell a signature failure from a
/// serializer bug.
fn assert_reported_with(root: &Path, code: &str, needle: &str) {
    let reg = Registry::load(root).expect("registry still parses after the edit");
    let violations = reg.check();
    assert!(
        violations
            .iter()
            .any(|v| v.code == code && v.detail.contains(needle)),
        "expected a {code:?} violation mentioning {needle:?}, got: {}",
        render(&violations)
    );
}

#[test]
fn the_committed_registry_is_clean_and_declares_every_contract_in_order() {
    let reg = load_clean();
    let ids: Vec<&str> = reg.contracts().iter().map(|c| c.id.as_str()).collect();
    assert_eq!(
        ids,
        ["intent", "grant", "lease", "approval", "decision", "mint"],
        "contract order is part of the registry: review order, not runtime order"
    );
}

#[test]
fn all_eight_target_languages_are_declared_once_each() {
    let reg = load_clean();
    let mut langs: Vec<String> = reg.languages().to_vec();
    langs.sort_unstable();
    assert_eq!(
        langs,
        [
            "clojure",
            "elixir",
            "go",
            "julia",
            "move",
            "python",
            "rust",
            "typescript"
        ],
        "V6-08-01 names seven service languages plus TypeScript"
    );
}

#[test]
fn a_tampered_fixture_field_is_caught_by_the_rebuilt_canonical_bytes() {
    let root = scratch_copy("tamper-fields");
    let path = root.join("contracts/v1/fixtures/grant/grant-0001/fields.json");
    let text = std::fs::read_to_string(&path).expect("grant fixture");
    // Raise a budget ceiling without re-signing: the rebuild no longer matches the
    // committed canonical digest, which is exactly what a re-canonicalising attacker
    // would have to defeat.
    let edited = text.replace("\"cloud_micros\": 250000", "\"cloud_micros\": 25000000");
    assert_ne!(
        edited, text,
        "fixture layout changed; update this negative test"
    );
    std::fs::write(&path, edited).expect("write tampered fields");
    assert_reported_with(&root, "fixture-broken", "canonical bytes differ");
}

#[test]
fn a_corrupted_fixture_signature_is_caught() {
    let root = scratch_copy("tamper-sig");
    let path = root.join("contracts/v1/fixtures/grant/grant-0001/sig.hex");
    let sig = std::fs::read_to_string(&path).expect("signature");
    let mut bytes: Vec<char> = sig.trim().chars().collect();
    bytes[0] = if bytes[0] == '0' { '1' } else { '0' };
    std::fs::write(
        &path,
        format!("{}\n", bytes.into_iter().collect::<String>()),
    )
    .expect("write signature");
    assert_reported_with(&root, "fixture-broken", "signature");
}

#[test]
fn a_fixture_that_contradicts_its_own_expectation_is_caught() {
    let root = scratch_copy("expect");
    let path = root.join("contracts/v1/fixtures/grant/grant-0001/expect.txt");
    std::fs::write(&path, "invalid\n").expect("write expectation");
    assert_reported(&root, "fixture-expectation");
}

#[test]
fn a_missing_implemented_verifier_is_caught() {
    let root = scratch_copy("missing-verifier");
    std::fs::remove_file(root.join("scripts/verify-lease.py")).expect("remove python verifier");
    assert_reported(&root, "consumer-missing");
}

#[test]
fn a_planned_verifier_that_already_exists_must_be_promoted() {
    // A registry that keeps saying "planned" after the verifier lands under-reports
    // coverage; the check refuses to let the status rot.
    let root = scratch_copy("stale-plan");
    let target = root.join("contracts/v1/verifiers/typescript/decision.ts");
    std::fs::create_dir_all(target.parent().expect("parent")).expect("verifier dir");
    std::fs::write(&target, "// not yet a verifier\n").expect("write placeholder");
    assert_reported(&root, "consumer-status-stale");
}

#[test]
fn a_domain_literal_in_the_kernel_that_is_not_registered_is_caught() {
    let root = scratch_copy("rogue-domain");
    std::fs::write(
        root.join("crates/agentos-policy/src/rogue.rs"),
        "pub const ROGUE_DOMAIN: &str = \"uap-rogue/1\";\n",
    )
    .expect("write rogue module");
    assert_reported(&root, "domain-unregistered");
}

#[test]
fn schema_field_order_must_equal_the_canonical_bytes_the_producer_emits() {
    let root = scratch_copy("schema-drift");
    let path = root.join("contracts/v1/schemas/grant.schema.json");
    let text = std::fs::read_to_string(&path).expect("grant schema");
    let edited = text.replace("\"max_risk\",\n", "");
    assert_ne!(
        edited, text,
        "schema layout changed; update this negative test"
    );
    std::fs::write(&path, edited).expect("write drifted schema");
    assert_reported(&root, "schema-fields-differ");
}

#[test]
fn an_output_contract_must_name_an_existing_test_that_covers_it() {
    let root = scratch_copy("covered-by");
    std::fs::remove_file(root.join("crates/agentos-policy/tests/authorize_bundle.rs"))
        .expect("remove coverage test");
    assert_reported(&root, "covered-by-missing");
}

#[test]
fn a_schema_without_a_versioned_domain_is_caught() {
    let root = scratch_copy("schema-domain");
    let path = root.join("contracts/v1/schemas/lease.schema.json");
    let text = std::fs::read_to_string(&path).expect("lease schema");
    let edited = text.replace("\"uap-lease/1\"", "\"uap-lease/2\"");
    assert_ne!(
        edited, text,
        "schema layout changed; update this negative test"
    );
    std::fs::write(&path, edited).expect("write drifted domain");
    assert_reported(&root, "schema-invalid");
}

#[test]
fn the_report_is_stable_machine_readable_json() {
    let reg = load_clean();
    let report: serde_json::Value = serde_json::from_str(&reg.report_json()).expect("report json");
    assert_eq!(report["v"], "uap-contracts/1");
    assert_eq!(report["ok"], true);
    assert_eq!(report["contracts"], 6);
    assert_eq!(report["languages"], 8);
    assert_eq!(
        report["fixtures"], 13,
        "5 lease + 3 grant + 2 approval + 3 intent fixtures are committed"
    );
    assert_eq!(report["violations"].as_array().map(Vec::len), Some(0));
}

#[test]
fn the_fixture_minter_is_deterministic_and_matches_what_is_committed() {
    let root = repo_root();
    let scratch =
        std::env::temp_dir().join(format!("uap-contract-fixtures-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&scratch);
    let status = Command::new(env!("CARGO_BIN_EXE_mint-contract-fixtures"))
        .arg(&scratch)
        .status()
        .expect("run mint-contract-fixtures");
    assert!(status.success(), "minter failed");
    assert_trees_equal(&scratch, &root.join("contracts/v1/fixtures"));
    let _ = std::fs::remove_dir_all(&scratch);
}

fn assert_trees_equal(a: &Path, b: &Path) {
    let mut entries: Vec<String> = Vec::new();
    collect(a, a, &mut entries);
    entries.sort();
    for rel in &entries {
        let left = std::fs::read(a.join(rel)).expect("generated file");
        let right = std::fs::read(b.join(rel))
            .unwrap_or_else(|e| panic!("committed fixture {rel} missing: {e}"));
        assert_eq!(
            left, right,
            "generated {rel} differs from the committed fixture"
        );
    }
    let mut committed: Vec<String> = Vec::new();
    collect(b, b, &mut committed);
    committed.sort();
    assert_eq!(
        entries, committed,
        "generated and committed fixture sets differ"
    );
}

fn collect(root: &Path, dir: &Path, out: &mut Vec<String>) {
    for entry in std::fs::read_dir(dir).expect("read tree") {
        let path = entry.expect("entry").path();
        if path.is_dir() {
            collect(root, &path, out);
        } else {
            out.push(
                path.strip_prefix(root)
                    .expect("inside tree")
                    .to_string_lossy()
                    .into_owned(),
            );
        }
    }
}
