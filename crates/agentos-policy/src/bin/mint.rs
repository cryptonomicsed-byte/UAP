//! `mint`: sign one grant/lease/approval from a JSON request on stdin.
//!
//! Separate from `authorize` on purpose: minting is the issuer's administrative act,
//! authorizing is the check. The seed arrives on stdin (never argv), and the seed is
//! never echoed in the answer — only its public half.

use std::io::Read;
use std::process::ExitCode;

use agentos_policy::authorize::mint_json;

fn main() -> ExitCode {
    let mut input = String::new();
    if let Err(e) = std::io::stdin().read_to_string(&mut input) {
        println!("{{\"error\":\"stdin: {e}\"}}");
        return ExitCode::from(2);
    }
    match mint_json(&input) {
        Ok(doc) => {
            println!("{doc}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            println!("{}", serde_json::json!({ "error": e }));
            ExitCode::from(2)
        }
    }
}
