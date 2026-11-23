//! Ed25519 signatures over canonical bytes.
//!
//! The kernel only ever *verifies*. Signing keys exist in this crate for two
//! legitimate uses — minting grants/leases in the issuer service and producing the
//! test fixtures — and the type deliberately makes the secret hard to mishandle: no
//! `Debug` of key material, no `Clone`, no accessor that returns the seed.

use core::fmt;
use core::str::FromStr;

use ed25519_dalek::{Signature as DalekSignature, Signer, SigningKey};

/// Re-exported so grantees can verify a document without depending on the dalek crate
/// directly (and so the curve library can be swapped behind one type).
pub use ed25519_dalek::VerifyingKey;

use crate::ids::IdError;

/// A 64-byte Ed25519 signature with one textual spelling (128 lowercase hex chars).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Signature([u8; 64]);

impl Signature {
    pub const fn from_bytes(bytes: [u8; 64]) -> Self {
        Self(bytes)
    }

    pub fn to_bytes(self) -> [u8; 64] {
        self.0
    }

    pub fn to_hex(self) -> String {
        let mut s = String::with_capacity(128);
        for b in self.0 {
            s.push(hex_nibble(b >> 4));
            s.push(hex_nibble(b & 0x0f));
        }
        s
    }

    pub fn parse_hex(s: &str) -> Result<Self, SigError> {
        if s.len() != 128 {
            return Err(SigError::Malformed);
        }
        let bytes = s.as_bytes();
        let mut out = [0u8; 64];
        for (i, slot) in out.iter_mut().enumerate() {
            let hi = unhex(bytes[2 * i]).ok_or(SigError::Malformed)?;
            let lo = unhex(bytes[2 * i + 1]).ok_or(SigError::Malformed)?;
            *slot = (hi << 4) | lo;
        }
        Ok(Self(out))
    }
}

impl fmt::Display for Signature {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_hex())
    }
}

/// Identifier of an issuing authority (the grant/lease signer's key id).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct IssuerId(String);

impl IssuerId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for IssuerId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl FromStr for IssuerId {
    type Err = IdError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
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
        for (i, b) in s.bytes().enumerate() {
            let first_ok = b.is_ascii_lowercase() || b.is_ascii_digit();
            let ok = if i == 0 {
                first_ok
            } else {
                first_ok || matches!(b, b'.' | b'_' | b':' | b'-')
            };
            if !ok {
                return Err(IdError::Char {
                    kind: "issuer id",
                    ch: b as char,
                    index: i,
                });
            }
        }
        Ok(Self(s.to_string()))
    }
}

/// An Ed25519 keypair. Debug prints the public half only.
pub struct SigningKeyPair(SigningKey);

impl fmt::Debug for SigningKeyPair {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SigningKeyPair")
            .field("public", &self.public_key_hex())
            .finish_non_exhaustive()
    }
}

impl SigningKeyPair {
    /// Deterministic keypair from a 32-byte seed. Callers are responsible for where the
    /// seed comes from (a KMS or an HSM in production, a fixture constant in tests).
    pub fn from_seed(seed: &[u8; 32]) -> Self {
        Self(SigningKey::from_bytes(seed))
    }

    pub fn public_key_hex(&self) -> String {
        to_hex(self.0.verifying_key().as_bytes())
    }

    pub fn verifying_key(&self) -> VerifyingKey {
        self.0.verifying_key()
    }

    pub fn sign(&self, msg: &[u8]) -> Signature {
        Signature(self.0.sign(msg).to_bytes())
    }
}

/// Signature verification failures. Deliberately coarse: a caller never learns whether
/// the key or the signature was malformed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SigError {
    /// A key or signature blob was not the expected length/encoding.
    Malformed,
    /// The signature does not verify against this key and message.
    Invalid,
}

impl fmt::Display for SigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SigError::Malformed => f.write_str("malformed key or signature encoding"),
            SigError::Invalid => f.write_str("signature does not verify"),
        }
    }
}

impl std::error::Error for SigError {}

pub fn verify(vk: &VerifyingKey, msg: &[u8], sig: &Signature) -> Result<(), SigError> {
    let s = DalekSignature::from_bytes(&sig.0);
    vk.verify_strict(msg, &s).map_err(|_| SigError::Invalid)
}

/// Parse a 32-byte verifying key from 64 lowercase hex characters.
pub fn verifying_key_from_hex(hex: &str) -> Result<VerifyingKey, SigError> {
    if hex.len() != 64 {
        return Err(SigError::Malformed);
    }
    let bytes = hex.as_bytes();
    let mut out = [0u8; 32];
    for (i, slot) in out.iter_mut().enumerate() {
        let hi = unhex(bytes[2 * i]).ok_or(SigError::Malformed)?;
        let lo = unhex(bytes[2 * i + 1]).ok_or(SigError::Malformed)?;
        *slot = (hi << 4) | lo;
    }
    VerifyingKey::from_bytes(&out).map_err(|_| SigError::Malformed)
}

fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(hex_nibble(b >> 4));
        s.push(hex_nibble(b & 0x0f));
    }
    s
}

fn hex_nibble(nibble: u8) -> char {
    match nibble {
        0..=9 => (b'0' + nibble) as char,
        _ => (b'a' + nibble - 10) as char,
    }
}

fn unhex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        _ => None,
    }
}
