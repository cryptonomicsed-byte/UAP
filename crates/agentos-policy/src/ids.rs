//! Canonical identifiers.
//!
//! Every id is validated at construction, so a value that exists cannot be re-parsed
//! differently by another language. This is not cosmetic: the policy kernel compares
//! ids with `==`, so `"acme"` and `"Acme"` would otherwise be two tenants with one
//! name, and `"repo:*"` would silently turn an exact-match grant into a wildcard.

use core::fmt;
use sha2::{Digest as _, Sha256};

/// Why an identifier was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdError {
    /// Empty string.
    Empty,
    /// Outside the permitted length range.
    Length { min: usize, max: usize, got: usize },
    /// A character outside the permitted set for this identifier kind.
    Char {
        kind: &'static str,
        ch: char,
        index: usize,
    },
    /// A digest was not exactly 64 lowercase hex characters.
    DigestHex,
}

impl fmt::Display for IdError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            IdError::Empty => write!(f, "identifier is empty"),
            IdError::Length { min, max, got } => {
                write!(f, "identifier length {got} outside {min}..={max}")
            }
            IdError::Char { kind, ch, index } => {
                write!(f, "invalid character {ch:?} at byte {index} in {kind}")
            }
            IdError::DigestHex => write!(f, "digest must be 64 lowercase hex characters"),
        }
    }
}

impl std::error::Error for IdError {}

/// Tenant slug: `[a-z0-9]` with interior `-`, 1..=64 bytes, lower-case only.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TenantId(String);

impl TenantId {
    pub fn parse(s: &str) -> Result<Self, IdError> {
        slug(s, "tenant id", 1, 64, true)?;
        Ok(Self(s.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for TenantId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Stable SID (agent instance identity): `[a-z0-9][a-z0-9._:-]{2,127}`.
///
/// The SID belongs to an *instance*, never to a prompt, a repo or a job
/// (V6-04-03). It is lower-case so a SID cannot collide with a display name.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Sid(String);

impl Sid {
    pub fn parse(s: &str) -> Result<Self, IdError> {
        if s.len() < 3 {
            return Err(IdError::Length {
                min: 3,
                max: 128,
                got: s.len(),
            });
        }
        if s.len() > 128 {
            return Err(IdError::Length {
                min: 3,
                max: 128,
                got: s.len(),
            });
        }
        for (i, ch) in s.char_indices() {
            let first_ok = ch.is_ascii_lowercase() || ch.is_ascii_digit();
            let later_ok = first_ok || matches!(ch, '.' | '_' | ':');
            let ok = if i == 0 { first_ok } else { later_ok };
            if !ok {
                return Err(IdError::Char {
                    kind: "sid",
                    ch,
                    index: i,
                });
            }
        }
        Ok(Self(s.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Sid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Tool name as the registry spells it: `[a-z0-9][a-z0-9._-]{0,127}`.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ToolName(String);

impl ToolName {
    pub fn parse(s: &str) -> Result<Self, IdError> {
        if s.is_empty() {
            return Err(IdError::Empty);
        }
        if s.len() > 128 {
            return Err(IdError::Length {
                min: 1,
                max: 128,
                got: s.len(),
            });
        }
        for (i, ch) in s.char_indices() {
            let first_ok = ch.is_ascii_lowercase() || ch.is_ascii_digit();
            let later_ok = first_ok || matches!(ch, '.' | '_' | '-');
            let ok = if i == 0 { first_ok } else { later_ok };
            if !ok {
                return Err(IdError::Char {
                    kind: "tool name",
                    ch,
                    index: i,
                });
            }
        }
        Ok(Self(s.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ToolName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A 32-byte digest with exactly one textual spelling (lowercase hex).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Digest([u8; 32]);

impl Digest {
    /// SHA-256 over `bytes` (domain separation is the caller's job at the protocol
    /// boundary; see [`crate::canonical`]).
    pub fn of(bytes: &[u8]) -> Self {
        let mut h = Sha256::new();
        h.update(bytes);
        Self(h.finalize().into())
    }

    pub const fn from_bytes(b: [u8; 32]) -> Self {
        Self(b)
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_hex(&self) -> String {
        let mut s = String::with_capacity(64);
        for b in self.0 {
            s.push(hex_digit(b >> 4));
            s.push(hex_digit(b & 0x0f));
        }
        s
    }

    pub fn parse_hex(s: &str) -> Result<Self, IdError> {
        if s.len() != 64 {
            return Err(IdError::DigestHex);
        }
        let bytes = s.as_bytes();
        let mut out = [0u8; 32];
        for i in 0..32 {
            let hi = unhex(bytes[2 * i])?;
            let lo = unhex(bytes[2 * i + 1])?;
            out[i] = (hi << 4) | lo;
        }
        Ok(Self(out))
    }
}

impl fmt::Display for Digest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_hex())
    }
}

fn hex_digit(nibble: u8) -> char {
    match nibble {
        0..=9 => (b'0' + nibble) as char,
        _ => (b'a' + nibble - 10) as char,
    }
}

fn unhex(b: u8) -> Result<u8, IdError> {
    match b {
        b'0'..=b'9' => Ok(b - b'0'),
        b'a'..=b'f' => Ok(b - b'a' + 10),
        // Uppercase hex is a different string; refuse it so digests have one spelling.
        _ => Err(IdError::DigestHex),
    }
}

/// Shared slug rule: lower-case ascii alnum, optional interior hyphens.
fn slug(
    s: &str,
    kind: &'static str,
    min: usize,
    max: usize,
    allow_dash: bool,
) -> Result<(), IdError> {
    if s.is_empty() {
        return Err(IdError::Empty);
    }
    if s.len() < min || s.len() > max {
        return Err(IdError::Length {
            min,
            max,
            got: s.len(),
        });
    }
    let bytes = s.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        let alnum = b.is_ascii_lowercase() || b.is_ascii_digit();
        let ok = if allow_dash && (i == 0 || i + 1 == bytes.len()) {
            alnum
        } else {
            alnum || (allow_dash && b == b'-')
        };
        if !ok {
            return Err(IdError::Char {
                kind,
                ch: b as char,
                index: i,
            });
        }
    }
    Ok(())
}
