//! H-27: check the shared contract registry against the code.
//!
//! Usage: `contract-check [repo-root]` (default: the current directory).
//!
//! Prints one JSON report on stdout (`uap-contracts/1`), a human summary on stderr,
//! and exits 1 when any violation is present so CI fails closed.

use std::path::PathBuf;
use std::process::ExitCode;

use agentos_policy::contracts::Registry;

fn main() -> ExitCode {
    let root = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let registry = match Registry::load(&root) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("contract-check: {e}");
            return ExitCode::from(2);
        }
    };
    let report = registry.report_json();
    println!("{report}");
    let ok = serde_json::from_str::<serde_json::Value>(&report)
        .ok()
        .and_then(|v| v["ok"].as_bool())
        .unwrap_or(false);
    if ok {
        eprintln!(
            "contract-check: {} contracts, {} languages, {} fixtures, 0 violations",
            registry.contracts().len(),
            registry.languages().len(),
            registry.fixture_count()
        );
        ExitCode::SUCCESS
    } else {
        for v in registry.check() {
            eprintln!("contract-check: [{}] {}", v.code, v.detail);
        }
        ExitCode::FAILURE
    }
}
