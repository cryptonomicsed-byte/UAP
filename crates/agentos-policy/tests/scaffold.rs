//! M1-03 (V6-05-01, contract layer 0): the crate exists, declares its protocol
//! version, and every identifier type refuses anything that could be re-parsed
//! differently by another language (whitespace, wildcards, uppercase, unicode).
//!
//! Identifiers are the root of the policy kernel: if a tenant id can contain `*`
//! or a space, every downstream exact-match check is a lie.

use agentos_policy::ids::{Digest, Sid, TenantId, ToolName};
use agentos_policy::API_VERSION;

#[test]
fn api_version_is_declared() {
    assert_eq!(API_VERSION, "uap-policy/0.1");
}

#[test]
fn tenant_id_rejects_empty_uppercase_wildcards_and_whitespace() {
    let long = "a".repeat(65);
    for bad in [
        "",
        "Acme",
        "acme corp",
        "acme/*",
        "acme*",
        "-acme",
        "acme-",
        "acme\n",
        "acmé",
        long.as_str(),
    ] {
        assert!(
            TenantId::parse(bad).is_err(),
            "TenantId must reject {bad:?} (got {:?})",
            TenantId::parse(bad).map(|t| t.as_str().to_string())
        );
    }
    let ok = TenantId::parse("acme-01").expect("valid tenant id");
    assert_eq!(ok.as_str(), "acme-01");
    assert_eq!(ok.to_string(), "acme-01");
}

#[test]
fn sid_rejects_empty_short_and_wildcard_values() {
    for bad in ["", "ab", "sid*", "sid with space", "SID_ABC", "sid\n"] {
        assert!(Sid::parse(bad).is_err(), "Sid must reject {bad:?}");
    }
    let ok = Sid::parse("sid_0a1b2c3d").expect("valid sid");
    assert_eq!(ok.as_str(), "sid_0a1b2c3d");
}

#[test]
fn tool_name_rejects_path_and_shell_characters() {
    for bad in [
        "",
        "../etc/passwd",
        "tool name",
        "tool;rm",
        "TOOL",
        "tool/x",
        "*",
    ] {
        assert!(
            ToolName::parse(bad).is_err(),
            "ToolName must reject {bad:?}"
        );
    }
    assert_eq!(
        ToolName::parse("browser.open_url").expect("valid").as_str(),
        "browser.open_url"
    );
}

#[test]
fn digest_is_lowercase_hex_of_exactly_32_bytes() {
    let d = Digest::of(b"hello");
    // Known SHA-256 of "hello".
    assert_eq!(
        d.to_hex(),
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
    let parsed = Digest::parse_hex(&d.to_hex()).expect("roundtrip");
    assert_eq!(parsed, d);
    // Uppercase, odd length, short and non-hex are all rejected: one canonical spelling.
    for bad in [
        "2CF24DBA5FB0A30E26E83B2AC5B9E29E1B161E5C1FA7425E73043362938B9824",
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b982",
        "zz",
        "",
    ] {
        assert!(Digest::parse_hex(bad).is_err(), "must reject {bad:?}");
    }
}
