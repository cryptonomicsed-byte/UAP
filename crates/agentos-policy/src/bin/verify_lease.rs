//! Verify one committed golden fixture directory and exit 0 iff the verifier's
//! conclusion matches `expect.txt`.
//!
//! Usage: `verify-lease <fixture-dir>`
//!
//! Prints one line: `verify-lease <name>: expect=<valid|invalid> got=<...>
//! sha256=<64 hex|-> reason=<text>` so the cross-language harness can also assert that
//! all four implementations agree on the canonical bytes.

use std::path::PathBuf;
use std::process::ExitCode;

use agentos_policy::fixtures::{expected, verify_dir};

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let Some(dir) = args.next() else {
        eprintln!("usage: verify-lease <fixture-dir>");
        return ExitCode::from(2);
    };
    if args.next().is_some() {
        eprintln!("usage: verify-lease <fixture-dir>");
        return ExitCode::from(2);
    }
    let dir = PathBuf::from(dir);
    let name = dir
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| dir.display().to_string());

    let want = match expected(&dir) {
        Ok(v) => v,
        Err(e) => {
            println!("verify-lease {name}: error=expect.txt:{e}");
            return ExitCode::from(1);
        }
    };
    let outcome = verify_dir(&dir);
    let sha = outcome.canonical_sha256.as_deref().unwrap_or("-");
    println!(
        "verify-lease {name}: expect={} got={} sha256={} reason={}",
        if want { "valid" } else { "invalid" },
        if outcome.verified { "valid" } else { "invalid" },
        sha,
        outcome.reason
    );
    if outcome.verified == want {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}
