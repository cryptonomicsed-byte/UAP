//! Canonical JSON: one byte string per document, reproducible in every language.
//!
//! # Rules (spec: `docs/architecture/POLICY-KERNEL.md` § Canonical encoding)
//!
//! * UTF-8, no BOM, no whitespace outside strings.
//! * Object keys in the exact order the writer emits them (one fixed schema per
//!   document type, not sorted at runtime — field order is part of the protocol).
//! * Numbers are non-negative integers in decimal, no sign, no leading zeros, no
//!   exponent. There are no floats in any signed document.
//! * Strings escape `"` `\` and control characters (as `\u00XX`, or the short forms
//!   `\b \f \n \r \t`); every other byte is emitted verbatim. Identifiers are
//!   charset-restricted, so in practice no escape ever fires — the escaper exists so
//!   the writer cannot be silently wrong if a free-text field (an advisory model
//!   name) is ever added.
//!
//! Signatures are computed over `domain || 0x0A || canonical_json`, see
//! [`signing_bytes`]. The domain tag prevents a signature made for a lease from
//! verifying as a grant.

/// Incremental writer for one canonical JSON object.
#[derive(Debug, Clone)]
pub struct CanonicalWriter {
    out: String,
    /// One entry per open object: has this object already emitted a member?
    need_comma: Vec<bool>,
}

impl Default for CanonicalWriter {
    fn default() -> Self {
        Self::new()
    }
}

impl CanonicalWriter {
    pub fn new() -> Self {
        Self {
            out: String::from("{"),
            need_comma: vec![false],
        }
    }

    fn key(&mut self, key: &str) {
        debug_assert!(!self.need_comma.is_empty());
        if *self.need_comma.last().expect("open object") {
            self.out.push(',');
        }
        *self.need_comma.last_mut().expect("open object") = true;
        self.out.push('"');
        escape_into(&mut self.out, key);
        self.out.push_str("\":");
    }

    pub fn field_str(&mut self, key: &str, value: &str) -> &mut Self {
        self.key(key);
        self.out.push('"');
        escape_into(&mut self.out, value);
        self.out.push('"');
        self
    }

    pub fn field_int(&mut self, key: &str, value: u64) -> &mut Self {
        self.key(key);
        self.out.push_str(&value.to_string());
        self
    }

    pub fn field_null(&mut self, key: &str) -> &mut Self {
        self.key(key);
        self.out.push_str("null");
        self
    }

    pub fn field_opt_str(&mut self, key: &str, value: Option<&str>) -> &mut Self {
        match value {
            Some(v) => self.field_str(key, v),
            None => self.field_null(key),
        }
    }

    pub fn begin_object(&mut self, key: &str) -> &mut Self {
        self.key(key);
        self.out.push('{');
        self.need_comma.push(false);
        self
    }

    pub fn end_object(&mut self) -> &mut Self {
        assert!(
            self.need_comma.len() > 1,
            "CanonicalWriter::end_object without a matching begin_object"
        );
        self.need_comma.pop();
        self.out.push('}');
        self
    }

    /// Close the root object and return the canonical bytes as a `String`.
    pub fn finish(mut self) -> String {
        assert_eq!(
            self.need_comma.len(),
            1,
            "CanonicalWriter::finish with {} unclosed object(s)",
            self.need_comma.len() - 1
        );
        self.out.push('}');
        self.out
    }
}

/// Append `s` to `out` with the canonical JSON escapes.
pub fn escape_into(out: &mut String, s: &str) {
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
}

/// Bytes that are signed: `domain`, LF, then the canonical JSON payload.
pub fn signing_bytes(domain: &str, payload: &str) -> Vec<u8> {
    let mut v = Vec::with_capacity(domain.len() + 1 + payload.len());
    v.extend_from_slice(domain.as_bytes());
    v.push(b'\n');
    v.extend_from_slice(payload.as_bytes());
    v
}
