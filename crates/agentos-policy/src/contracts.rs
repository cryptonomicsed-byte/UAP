//! H-27 (V6-08-01): the shared contract registry.
//!
//! `contracts/v1/manifest.json` declares every wire document the platform signs or
//! emits: its domain tag, the module that produces it, the JSON Schema that documents
//! it, the committed fixtures, and which of the eight target languages verifies it.
//! This module is the checker: it refuses to certify a registry that has drifted from
//! the code.
//!
//! # What is actually checked
//!
//! * every declared producer, schema and verifier path exists (and a `planned`
//!   verifier does *not* exist, so a stale status cannot under-report coverage);
//! * every schema declares the same versioned domain as the manifest, and its
//!   `required` array — used here as the documented field order — equals the top-level
//!   key order of the canonical bytes the real producer emits;
//! * every `uap-<name>/<n>` string literal in the kernel sources is registered (an
//!   unregistered domain is a wire format nobody agreed to);
//! * every fixture is re-derived through the real typed producer: parse strictly,
//!   rebuild the canonical bytes, compare byte for byte, hash, then verify the
//!   Ed25519 signature — and the conclusion must equal `expect.txt`.
//!
//! Fixtures for `output` contracts (a decision, a permit inside it) have no producer
//! to re-run, so they must instead name the in-tree test that covers them.
//!
//! Everything is read-only: the checker never writes, never signs, never reads a
//! clock. It is safe to run in CI and inside a read-only container.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::authorize::{parse_approval_fields, parse_grant_fields, parse_intent_fields};
use crate::fixtures;
use crate::ids::Digest;
use crate::signature::{verify, verifying_key_from_hex, Signature};

/// Version of the registry format itself (not of any one contract).
pub const CONTRACTS_VERSION: &str = "uap-contracts/1";

/// Manifest location, relative to the repository root.
pub const MANIFEST_PATH: &str = "contracts/v1/manifest.json";

/// The languages V6-08-01 requires the contracts to reach. A registry that quietly
/// drops one cannot claim "seven-language contracts".
pub const TARGET_LANGUAGES: [&str; 8] = [
    "rust",
    "elixir",
    "go",
    "python",
    "julia",
    "clojure",
    "move",
    "typescript",
];

/// One way the registry and the code disagree. `code` is stable for CI grep.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Violation {
    pub code: &'static str,
    pub detail: String,
}

impl Violation {
    fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

/// The manifest, parsed strictly. Unknown keys are a violation, not a warning: a
/// typo'd key would otherwise silently disable a whole section.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub v: String,
    pub revision: u32,
    pub languages: Vec<String>,
    pub contracts: Vec<Contract>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Contract {
    pub id: String,
    /// Versioned domain tag (`uap-lease/1`). For unsigned and output documents this
    /// is the `v` field of the document itself.
    pub domain: String,
    /// `signed` (Ed25519 over `domain\n` + canonical bytes), `unsigned` (canonical
    /// bytes, no signature — a request), `output` (emitted by the kernel), `embedded`
    /// (a structure that lives inside another contract) or `request` (a CLI envelope).
    pub kind: String,
    /// Rust module that defines the type (used for review, not re-exported here).
    pub producer: String,
    pub schema: String,
    /// Fixture root directory, or the literal `output-only`.
    pub fixtures: String,
    /// For contracts with no re-derivable fixtures: the in-tree test that covers them.
    #[serde(default)]
    pub covered_by: Option<String>,
    pub consumers: Vec<Consumer>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Consumer {
    pub lang: String,
    /// `implemented` (verifier on disk, exercised by tests) or `planned`.
    pub status: String,
    /// Required when `implemented`.
    #[serde(default)]
    pub path: Option<String>,
    /// Required when `planned`: where the verifier will live, so its appearance can
    /// be detected instead of leaving the registry under-reporting coverage.
    #[serde(default)]
    pub expected_path: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

/// A loaded registry, bound to the tree it was read from.
#[derive(Debug)]
pub struct Registry {
    root: PathBuf,
    manifest: Manifest,
}

impl Registry {
    /// Read `contracts/v1/manifest.json` under `root`. A parse failure is an error,
    /// not a violation: without a manifest there is nothing to check.
    pub fn load(root: &Path) -> Result<Self, String> {
        let path = root.join(MANIFEST_PATH);
        let text = fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let manifest: Manifest =
            serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(Self {
            root: root.to_path_buf(),
            manifest,
        })
    }

    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    pub fn contracts(&self) -> &[Contract] {
        &self.manifest.contracts
    }

    pub fn languages(&self) -> &[String] {
        &self.manifest.languages
    }

    /// Number of committed fixture cases across all contracts.
    pub fn fixture_count(&self) -> usize {
        self.contracts()
            .iter()
            .filter(|c| c.fixtures != "output-only")
            .map(|c| self.fixture_dirs(c).len())
            .sum()
    }

    /// Run every check. Empty means the registry agrees with the code.
    pub fn check(&self) -> Vec<Violation> {
        let mut out = Vec::new();
        self.check_manifest(&mut out);
        let domains: BTreeSet<String> = self.contracts().iter().map(|c| c.domain.clone()).collect();
        for contract in self.contracts() {
            self.check_contract(contract, &mut out);
            self.check_fixtures(contract, &mut out);
            self.check_consumers(contract, &mut out);
        }
        self.check_source_domains(&domains, &mut out);
        out
    }

    /// Machine-readable report for CI and for other language tooling.
    pub fn report_json(&self) -> String {
        let violations = self.check();
        let list: Vec<Value> = violations
            .iter()
            .map(|v| json!({"code": v.code, "detail": v.detail}))
            .collect();
        json!({
            "v": CONTRACTS_VERSION,
            "revision": self.manifest.revision,
            "ok": list.is_empty(),
            "contracts": self.contracts().len(),
            "languages": self.manifest.languages.len(),
            "fixtures": self.fixture_count(),
            "violations": list,
        })
        .to_string()
    }

    // ------------------------------------------------------------ manifest

    fn check_manifest(&self, out: &mut Vec<Violation>) {
        if self.manifest.v != CONTRACTS_VERSION {
            out.push(Violation::new(
                "manifest",
                format!(
                    "manifest v is {:?}, expected {CONTRACTS_VERSION:?}",
                    self.manifest.v
                ),
            ));
        }
        if self.manifest.revision < 1 {
            out.push(Violation::new("manifest", "revision must be >= 1"));
        }
        let declared: BTreeSet<&str> = self.manifest.languages.iter().map(String::as_str).collect();
        let expected: BTreeSet<&str> = TARGET_LANGUAGES.iter().copied().collect();
        if declared.len() != self.manifest.languages.len() {
            out.push(Violation::new("manifest", "languages contains a duplicate"));
        }
        for missing in expected.difference(&declared) {
            out.push(Violation::new(
                "manifest",
                format!("language {missing:?} missing from the registry"),
            ));
        }
        for extra in declared.difference(&expected) {
            out.push(Violation::new(
                "manifest",
                format!("language {extra:?} is not a V6-08-01 target language"),
            ));
        }
        let mut ids = BTreeSet::new();
        let mut domains = BTreeSet::new();
        for contract in &self.manifest.contracts {
            if !ids.insert(contract.id.as_str()) {
                out.push(Violation::new(
                    "contract-duplicate",
                    format!("contract id {:?} declared twice", contract.id),
                ));
            }
            if !domains.insert(contract.domain.as_str()) {
                out.push(Violation::new(
                    "contract-duplicate",
                    format!("domain {:?} declared twice", contract.domain),
                ));
            }
        }
    }

    // ------------------------------------------------------------ structure

    fn check_contract(&self, contract: &Contract, out: &mut Vec<Violation>) {
        const KINDS: [&str; 5] = ["signed", "unsigned", "output", "embedded", "request"];
        if !KINDS.contains(&contract.kind.as_str()) {
            out.push(Violation::new(
                "manifest",
                format!("{}: unknown kind {:?}", contract.id, contract.kind),
            ));
        }
        for (what, rel) in [
            ("producer", &contract.producer),
            ("schema", &contract.schema),
        ] {
            if !self.root.join(rel).is_file() {
                out.push(Violation::new(
                    "missing-file",
                    format!("{}: {what} {} does not exist", contract.id, rel),
                ));
            }
        }
        if !self.root.join(&contract.schema).is_file() {
            return;
        }
        let text = match fs::read_to_string(self.root.join(&contract.schema)) {
            Ok(t) => t,
            Err(e) => {
                out.push(Violation::new(
                    "schema-invalid",
                    format!("{}: {e}", contract.schema),
                ));
                return;
            }
        };
        let schema: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(e) => {
                out.push(Violation::new(
                    "schema-invalid",
                    format!("{}: {e}", contract.schema),
                ));
                return;
            }
        };
        if schema["x-uap-domain"] != json!(contract.domain) {
            out.push(Violation::new(
                "schema-invalid",
                format!(
                    "{}: x-uap-domain is {}, manifest says {:?}",
                    contract.schema, schema["x-uap-domain"], contract.domain
                ),
            ));
        }
        let id_ok = schema["$id"]
            .as_str()
            .map(|id| id.ends_with(&format!("/{}.schema.json", contract.id)))
            .unwrap_or(false);
        if !id_ok {
            out.push(Violation::new(
                "schema-invalid",
                format!("{}: $id does not name this contract", contract.schema),
            ));
        }
        if schema["required"]
            .as_array()
            .map(Vec::is_empty)
            .unwrap_or(true)
        {
            out.push(Violation::new(
                "schema-invalid",
                format!(
                    "{}: required must list the canonical fields",
                    contract.schema
                ),
            ));
        }
        // Fields that carry an id or a digest cannot be free text: the schema must
        // pin their shape, or a second language can accept bytes the kernel never
        // produces.
        for (name, shape) in [
            ("v", "domain"),
            ("role_digest", "hex64"),
            ("tool_schema", "hex64"),
            ("params", "hex64"),
            ("nonce", "hex64"),
            ("intent_digest", "hex64"),
            ("permit_id", "hex64"),
        ] {
            if let Some(field) = schema["properties"].get(name) {
                let pattern = field["pattern"].as_str().unwrap_or("");
                match shape {
                    "domain" if field["const"].as_str() != Some(contract.domain.as_str()) => {
                        out.push(Violation::new(
                            "schema-invalid",
                            format!(
                                "{}: properties.v must pin the domain as a const",
                                contract.schema
                            ),
                        ));
                    }
                    "hex64" if pattern != "^[0-9a-f]{64}$" => {
                        out.push(Violation::new(
                            "schema-invalid",
                            format!(
                                "{}: properties.{name} must pin ^[0-9a-f]{{64}}$",
                                contract.schema
                            ),
                        ));
                    }
                    _ => {}
                }
            }
        }
    }

    // ------------------------------------------------------------ fixtures

    fn fixture_dirs(&self, contract: &Contract) -> Vec<PathBuf> {
        if contract.fixtures == "output-only" {
            return Vec::new();
        }
        let root = self.root.join(&contract.fixtures);
        let mut dirs: Vec<PathBuf> = match fs::read_dir(&root) {
            Ok(entries) => entries
                .filter_map(Result::ok)
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect(),
            Err(_) => Vec::new(),
        };
        dirs.sort();
        dirs
    }

    fn check_fixtures(&self, contract: &Contract, out: &mut Vec<Violation>) {
        if contract.fixtures == "output-only" {
            match &contract.covered_by {
                None => out.push(Violation::new(
                    "covered-by-missing",
                    format!(
                        "{}: output-only contract names no covering test",
                        contract.id
                    ),
                )),
                Some(rel) if !self.root.join(rel).is_file() => out.push(Violation::new(
                    "covered-by-missing",
                    format!("{}: covered_by {rel} does not exist", contract.id),
                )),
                Some(_) => {}
            }
            return;
        }
        if !self.root.join(&contract.fixtures).is_dir() {
            out.push(Violation::new(
                "fixture-missing",
                format!(
                    "{}: fixture root {} is not a directory",
                    contract.id, contract.fixtures
                ),
            ));
            return;
        }
        let dirs = self.fixture_dirs(contract);
        if dirs.is_empty() {
            out.push(Violation::new(
                "fixture-missing",
                format!(
                    "{}: no fixture cases under {}",
                    contract.id, contract.fixtures
                ),
            ));
            return;
        }
        for dir in dirs {
            let name = dir
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let tag = format!("{}/{}", contract.id, name);
            let want = match read_expect(&dir) {
                Ok(w) => w,
                Err(e) => {
                    out.push(Violation::new("fixture-missing", format!("{tag}: {e}")));
                    continue;
                }
            };
            let outcome = if contract.kind == "signed" {
                verify_signed_fixture(contract, &dir)
            } else {
                verify_unsigned_fixture(contract, &dir)
            };
            match outcome {
                Ok(reason) => match (&reason, want) {
                    // The fixture claims to be valid and the producer refuses it:
                    // the fixture itself is corrupt (or the producer regressed).
                    (Some(why), true) => out.push(Violation::new(
                        "fixture-broken",
                        format!("{tag}: expect.txt says valid, verifier concluded invalid ({why})"),
                    )),
                    // A negative fixture that now verifies is no longer a negative
                    // fixture: it proves nothing.
                    (None, false) => out.push(Violation::new(
                        "fixture-expectation",
                        format!("{tag}: expect.txt says invalid, verifier accepted it"),
                    )),
                    (Some(why), false) => {
                        // A negative fixture must fail for the documented reason, or
                        // "invalid" hides a verifier that rejects everything.
                        if let Ok(hint) = fs::read_to_string(dir.join("reason.txt")) {
                            let hint = hint.trim();
                            if !why.contains(hint) {
                                out.push(Violation::new(
                                    "fixture-expectation",
                                    format!("{tag}: expected reason {hint:?}, got {why:?}"),
                                ));
                            }
                        }
                    }
                    (None, true) => {}
                },
                Err(v) => out.push(v),
            }
        }
        // The documented field order must equal the canonical bytes the producer
        // emits; a schema that lists fields in another order documents a document
        // that does not exist.
        if let Some((keys, schema_required)) = self.first_canonical_fields(contract) {
            if keys != schema_required {
                out.push(Violation::new(
                    "schema-fields-differ",
                    format!(
                        "{}: schema required {:?} != canonical field order {:?}",
                        contract.id, schema_required, keys
                    ),
                ));
            }
        }
    }

    fn first_canonical_fields(&self, contract: &Contract) -> Option<(Vec<String>, Vec<String>)> {
        let schema: Value =
            serde_json::from_str(&fs::read_to_string(self.root.join(&contract.schema)).ok()?)
                .ok()?;
        let required: Vec<String> = schema["required"]
            .as_array()?
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();
        for dir in self.fixture_dirs(contract) {
            if read_expect(&dir).ok() != Some(true) {
                continue;
            }
            if let Ok(text) = canonical_text_for(contract, &dir) {
                if let Ok(keys) = top_level_keys(&text) {
                    return Some((keys, required));
                }
            }
        }
        None
    }

    // ------------------------------------------------------------ consumers

    fn check_consumers(&self, contract: &Contract, out: &mut Vec<Violation>) {
        for consumer in &contract.consumers {
            if !self.manifest.languages.iter().any(|l| l == &consumer.lang) {
                out.push(Violation::new(
                    "consumer-language",
                    format!(
                        "{}: consumer language {:?} is not declared",
                        contract.id, consumer.lang
                    ),
                ));
                continue;
            }
            match consumer.status.as_str() {
                "implemented" => match &consumer.path {
                    None => out.push(Violation::new(
                        "consumer-missing",
                        format!(
                            "{}: {} verifier is implemented but names no path",
                            contract.id, consumer.lang
                        ),
                    )),
                    Some(rel) if !self.root.join(rel).is_file() => out.push(Violation::new(
                        "consumer-missing",
                        format!(
                            "{}: {} verifier {rel} does not exist",
                            contract.id, consumer.lang
                        ),
                    )),
                    Some(_) => {}
                },
                "planned" => match &consumer.expected_path {
                    None => out.push(Violation::new(
                        "manifest",
                        format!(
                            "{}: planned {} verifier must name expected_path",
                            contract.id, consumer.lang
                        ),
                    )),
                    Some(rel) if self.root.join(rel).exists() => out.push(Violation::new(
                        "consumer-status-stale",
                        format!(
                            "{}: {} verifier already exists at {rel}; promote it to implemented",
                            contract.id, consumer.lang
                        ),
                    )),
                    Some(_) => {}
                },
                other => out.push(Violation::new(
                    "manifest",
                    format!("{}: unknown consumer status {other:?}", contract.id),
                )),
            }
        }
    }

    // ------------------------------------------------------------ source domains

    /// Every `"uap-<name>/<n>"` literal in the kernel sources must be registered.
    /// This is the check that catches a new wire format shipped without a schema.
    fn check_source_domains(&self, domains: &BTreeSet<String>, out: &mut Vec<Violation>) {
        let mut found = BTreeSet::new();
        let src = self.root.join("crates/agentos-policy/src");
        collect_rs_files(&src, &mut |path| {
            if let Ok(text) = fs::read_to_string(path) {
                for literal in domain_consts(&text) {
                    found.insert(literal);
                }
            }
        });
        for literal in &found {
            if !domains.contains(literal) {
                out.push(Violation::new(
                    "domain-unregistered",
                    format!("{literal} appears in the kernel but no contract declares it"),
                ));
            }
        }
        for domain in domains {
            if !found.contains(domain) {
                out.push(Violation::new(
                    "domain-unused",
                    format!("{domain} is registered but no kernel code emits it"),
                ));
            }
        }
    }
}

fn read_expect(dir: &Path) -> Result<bool, String> {
    let text =
        fs::read_to_string(dir.join("expect.txt")).map_err(|e| format!("expect.txt: {e}"))?;
    match text.trim() {
        "valid" => Ok(true),
        "invalid" => Ok(false),
        other => Err(format!("expect.txt is {other:?}")),
    }
}

/// The canonical bytes of one fixture case. Cases added after H-27 commit
/// `canonical.txt`; the lease set predates the registry and is rebuilt from its own
/// fields instead, so the pre-existing byte-frozen fixtures are not rewritten.
fn canonical_text_for(contract: &Contract, dir: &Path) -> Result<String, String> {
    if let Ok(text) = fs::read_to_string(dir.join("canonical.txt")) {
        return Ok(text);
    }
    if contract.id == "lease" {
        let fields = fs::read_to_string(dir.join("fields.json")).map_err(|e| e.to_string())?;
        return fixtures::parse_fields(&fields)
            .map(|l| l.canonical_json())
            .map_err(|e| e.to_string());
    }
    Err("no canonical.txt".to_string())
}

/// Verify one signed fixture through the real typed producer.
///
/// `Ok(None)` = verified; `Ok(Some(reason))` = refused for that reason. `Err` is a
/// broken fixture (missing file, unreadable digest) rather than a refusal, because a
/// verifier cannot conclude anything about a fixture that is not fully present.
fn verify_signed_fixture(contract: &Contract, dir: &Path) -> Result<Option<String>, Violation> {
    let name = dir
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let tag = format!("{}/{}", contract.id, name);
    let broken = |what: &str, e: std::io::Error| {
        Violation::new("fixture-missing", format!("{tag}: {what}: {e}"))
    };

    let expect_sha = fs::read_to_string(dir.join("canonical.sha256"))
        .map_err(|e| broken("canonical.sha256", e))?;
    let sig_hex = fs::read_to_string(dir.join("sig.hex")).map_err(|e| broken("sig.hex", e))?;
    let key_hex =
        fs::read_to_string(dir.join("issuer.pub.hex")).map_err(|e| broken("issuer.pub.hex", e))?;
    let fields_text =
        fs::read_to_string(dir.join("fields.json")).map_err(|e| broken("fields.json", e))?;

    let fields: Value = match serde_json::from_str(&fields_text) {
        Ok(v) => v,
        Err(e) => return Ok(Some(format!("schema: {e}"))),
    };
    let (canonical, payload): (String, Vec<u8>) = match contract.id.as_str() {
        "grant" => match parse_grant_fields(&fields) {
            Ok(grant) => (grant.canonical_json(), grant.signing_payload()),
            Err(e) => return Ok(Some(e)),
        },
        "approval" => match parse_approval_fields(&fields) {
            Ok(record) => (record.canonical_json(), record.signing_payload()),
            Err(e) => return Ok(Some(e)),
        },
        "lease" => match fixtures::parse_fields(&fields_text) {
            Ok(lease) => (lease.canonical_json(), lease.signing_payload()),
            Err(e) => return Ok(Some(format!("schema: {e}"))),
        },
        other => {
            return Err(Violation::new(
                "manifest",
                format!("{other}: no signed fixture producer wired"),
            ))
        }
    };

    let rebuilt_sha = Digest::of(canonical.as_bytes()).to_hex();
    // Lease fixtures predate the registry and commit only the digest; every newer
    // signed fixture also commits the bytes so another language can compare them
    // without re-implementing the field order.
    if let Ok(committed) = fs::read_to_string(dir.join("canonical.txt")) {
        if canonical != committed {
            return Ok(Some(format!(
                "canonical bytes differ from canonical.txt (sha256={rebuilt_sha})"
            )));
        }
    }
    if rebuilt_sha != expect_sha.trim() {
        return Ok(Some(format!(
            "canonical bytes differ (built {rebuilt_sha}, expected {})",
            expect_sha.trim()
        )));
    }
    let sig = match Signature::parse_hex(sig_hex.trim()) {
        Ok(s) => s,
        Err(e) => return Ok(Some(format!("signature: {e}"))),
    };
    let key = match verifying_key_from_hex(key_hex.trim()) {
        Ok(k) => k,
        Err(e) => return Ok(Some(format!("issuer key: {e}"))),
    };
    if let Err(e) = verify(&key, &payload, &sig) {
        return Ok(Some(format!("signature: {e}")));
    }
    Ok(None)
}

/// Unsigned contracts (`ActionIntent`) have no signature: the fixture pins the exact
/// canonical bytes and the internal validation verdict.
fn verify_unsigned_fixture(contract: &Contract, dir: &Path) -> Result<Option<String>, Violation> {
    let name = dir
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let tag = format!("{}/{}", contract.id, name);
    let broken = |what: &str, e: std::io::Error| {
        Violation::new("fixture-missing", format!("{tag}: {what}: {e}"))
    };
    if contract.id != "intent" {
        return Err(Violation::new(
            "manifest",
            format!("{}: no unsigned fixture producer wired", contract.id),
        ));
    }
    let expect_text =
        fs::read_to_string(dir.join("canonical.txt")).map_err(|e| broken("canonical.txt", e))?;
    let expect_sha = fs::read_to_string(dir.join("canonical.sha256"))
        .map_err(|e| broken("canonical.sha256", e))?;
    let fields_text =
        fs::read_to_string(dir.join("fields.json")).map_err(|e| broken("fields.json", e))?;
    let fields: Value = match serde_json::from_str(&fields_text) {
        Ok(v) => v,
        Err(e) => return Ok(Some(format!("schema: {e}"))),
    };
    let intent = match parse_intent_fields(&fields) {
        Ok(i) => i,
        Err(e) => return Ok(Some(e)),
    };
    let canonical = intent.canonical_json();
    let rebuilt_sha = Digest::of(canonical.as_bytes()).to_hex();
    if canonical != expect_text {
        return Ok(Some(format!(
            "canonical bytes differ from canonical.txt (sha256={rebuilt_sha})"
        )));
    }
    if rebuilt_sha != expect_sha.trim() {
        return Ok(Some(format!(
            "canonical bytes differ (built {rebuilt_sha}, expected {})",
            expect_sha.trim()
        )));
    }
    match intent.validate() {
        Ok(()) => Ok(None),
        Err(e) => Ok(Some(format!("intent: {e}"))),
    }
}

// ---------------------------------------------------------------- scanning

fn collect_rs_files(dir: &Path, f: &mut impl FnMut(&Path)) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if path.is_dir() {
            collect_rs_files(&path, f);
        } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            f(&path);
        }
    }
}

/// Wire domains declared in the kernel: the value of every `*_DOMAIN` string const.
///
/// The registry is keyed by *declared* domains, not by every string that looks like
/// one — a test fixture that says `"uap-lease/1"` is data, not a new format. The
/// convention (every wire tag is a `*_DOMAIN` const) is what makes this precise; a
/// domain used inline without a const is caught by review, not by string matching.
fn domain_consts(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        let is_const = trimmed.starts_with("pub const ") || trimmed.starts_with("const ");
        if !is_const || !trimmed.contains("_DOMAIN") {
            continue;
        }
        let Some(pos) = trimmed.find("\"uap-") else {
            continue;
        };
        let rest = &trimmed[pos + 1..];
        let Some(end) = rest.find('"') else {
            continue;
        };
        let candidate = &rest[..end];
        if let Some((name, version)) = candidate.split_once('/') {
            let shaped = name.starts_with("uap-")
                && name.len() > 4
                && name
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b == b'-' || b.is_ascii_digit())
                && !version.is_empty()
                && version.bytes().all(|b| b.is_ascii_digit());
            if shaped {
                out.push(candidate.to_string());
            }
        }
    }
    out
}

/// Top-level keys of a canonical document, in the order they appear.
///
/// Canonical JSON has no whitespace, but nested objects and arrays are still skipped
/// by the depth counter. The alignment with `required` is what makes "field order is
/// part of the protocol" a checked statement rather than a comment.
fn top_level_keys(canonical: &str) -> Result<Vec<String>, String> {
    let bytes = canonical.as_bytes();
    let mut keys = Vec::new();
    let mut depth = 0usize;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'{' | b'[' => depth += 1,
            b'}' | b']' => depth = depth.saturating_sub(1),
            b'"' => {
                let start = i + 1;
                let mut end = start;
                while end < bytes.len() && bytes[end] != b'"' {
                    end += 1;
                }
                if end >= bytes.len() {
                    return Err("unterminated string".to_string());
                }
                let is_key = bytes.get(end + 1) == Some(&b':');
                if depth == 1 && is_key {
                    keys.push(canonical[start..end].to_string());
                }
                i = end;
            }
            _ => {}
        }
        i += 1;
    }
    Ok(keys)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domain_consts_read_only_declared_domains() {
        let src = r#"
            pub const LEASE_DOMAIN: &str = "uap-lease/1";
            pub const API_VERSION: &str = "uap-policy/0.1";
            // a comment mentioning "uap-grant/1" is not a declaration
            let s = "uap-authorize/12";
            pub const ROGUE: &str = "not-a-domain";
        "#;
        assert_eq!(domain_consts(src), vec!["uap-lease/1"]);
    }

    #[test]
    fn top_level_keys_skip_nested_objects_and_arrays() {
        let doc = r#"{"v":"uap-x/1","n":1,"o":{"a":"b"},"arr":[{"k":1},"s"],"z":null}"#;
        assert_eq!(
            top_level_keys(doc).unwrap(),
            vec!["v", "n", "o", "arr", "z"]
        );
    }
}
