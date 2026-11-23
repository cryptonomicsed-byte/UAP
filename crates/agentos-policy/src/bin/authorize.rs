//! `authorize`: decide one model-proposed tool intent against the signed policy bundle.
//!
//! Reads the bundle on stdin, writes the decision JSON on stdout. Exit codes:
//! `0` allowed, `10` refused by policy, `20` malformed request — so a caller can fail
//! closed on any non-zero status without parsing the answer.

use std::io::Read;
use std::process::ExitCode;

use agentos_policy::authorize::{authorize_bundle, exit_code_for};

fn main() -> ExitCode {
    let mut input = String::new();
    if let Err(e) = std::io::stdin().read_to_string(&mut input) {
        println!(
            "{}",
            serde_json::json!({
                "v": agentos_policy::authorize::AUTHORIZE_DOMAIN,
                "allowed": false,
                "code": "invalid-request",
                "detail": format!("stdin: {e}"),
            })
        );
        return ExitCode::from(agentos_policy::authorize::EXIT_INVALID as u8);
    }
    match authorize_bundle(&input) {
        Ok(decision) => {
            println!("{decision}");
            ExitCode::from(exit_code_for(&decision) as u8)
        }
        Err(e) => {
            println!(
                "{}",
                serde_json::json!({
                    "v": agentos_policy::authorize::AUTHORIZE_DOMAIN,
                    "allowed": false,
                    "code": "invalid-request",
                    "detail": format!("bridge: {e}"),
                })
            );
            ExitCode::from(agentos_policy::authorize::EXIT_INVALID as u8)
        }
    }
}
