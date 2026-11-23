//! Resource scopes (exact targets) and resource patterns (grant-side, the only place a
//! wildcard is legal).
//!
//! The distinction is the whole point of V6-05-02: a dispatch target must name one
//! concrete resource; a grant may cover a subtree. If a dispatch target could carry
//! `*`, a single mis-serialised intent would widen its own authority.

use core::fmt;

use crate::ids::IdError;

/// The kinds of resource the kernel can reason about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ResourceKind {
    Tool,
    File,
    HttpOrigin,
    Repo,
    Database,
    CloudAccount,
    Model,
    VaultSecret,
    Queue,
    Dataset,
}

impl ResourceKind {
    pub const ALL: [ResourceKind; 10] = [
        ResourceKind::Tool,
        ResourceKind::File,
        ResourceKind::HttpOrigin,
        ResourceKind::Repo,
        ResourceKind::Database,
        ResourceKind::CloudAccount,
        ResourceKind::Model,
        ResourceKind::VaultSecret,
        ResourceKind::Queue,
        ResourceKind::Dataset,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ResourceKind::Tool => "tool",
            ResourceKind::File => "file",
            ResourceKind::HttpOrigin => "http_origin",
            ResourceKind::Repo => "repo",
            ResourceKind::Database => "database",
            ResourceKind::CloudAccount => "cloud_account",
            ResourceKind::Model => "model",
            ResourceKind::VaultSecret => "vault_secret",
            ResourceKind::Queue => "queue",
            ResourceKind::Dataset => "dataset",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "tool" => ResourceKind::Tool,
            "file" => ResourceKind::File,
            "http_origin" => ResourceKind::HttpOrigin,
            "repo" => ResourceKind::Repo,
            "database" => ResourceKind::Database,
            "cloud_account" => ResourceKind::CloudAccount,
            "model" => ResourceKind::Model,
            "vault_secret" => ResourceKind::VaultSecret,
            "queue" => ResourceKind::Queue,
            "dataset" => ResourceKind::Dataset,
            _ => return None,
        })
    }
}

impl fmt::Display for ResourceKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One concrete resource: `kind:id`.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ResourceScope {
    kind: ResourceKind,
    id: String,
}

impl ResourceScope {
    pub fn parse(raw: &str) -> Result<Self, IdError> {
        let (kind, id) = split_kind(raw)?;
        validate_id(id, "resource id")?;
        Ok(Self {
            kind,
            id: id.to_string(),
        })
    }

    pub fn new(kind: ResourceKind, id: &str) -> Result<Self, IdError> {
        validate_id(id, "resource id")?;
        Ok(Self {
            kind,
            id: id.to_string(),
        })
    }

    pub fn kind(&self) -> ResourceKind {
        self.kind
    }

    pub fn id(&self) -> &str {
        &self.id
    }
}

impl fmt::Display for ResourceScope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.kind, self.id)
    }
}

/// A grant-side resource rule: exact id, `subtree/*`, or `*` (any of the kind).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ResourcePattern {
    kind: ResourceKind,
    /// `"*"`, `"prefix/*"`, or an exact id.
    pattern: String,
}

impl ResourcePattern {
    pub fn parse(raw: &str) -> Result<Self, IdError> {
        let (kind, pat) = split_kind(raw)?;
        if pat == "*" {
            return Ok(Self {
                kind,
                pattern: "*".to_string(),
            });
        }
        if let Some(prefix) = pat.strip_suffix("/*") {
            if prefix.is_empty() {
                return Err(IdError::Empty);
            }
            // The prefix itself must be a valid id and must not contain another '*'.
            validate_id(prefix, "resource pattern prefix")?;
            return Ok(Self {
                kind,
                pattern: pat.to_string(),
            });
        }
        validate_id(pat, "resource pattern")?;
        Ok(Self {
            kind,
            pattern: pat.to_string(),
        })
    }

    /// Every resource of `kind`. Explicit, so an "any" grant is visible in the grant.
    pub fn any_of(kind: ResourceKind) -> Self {
        Self {
            kind,
            pattern: "*".to_string(),
        }
    }

    pub fn kind(&self) -> ResourceKind {
        self.kind
    }

    /// The pattern text without its kind prefix (`"*"`, `"acme/*"` or an exact id).
    pub fn pattern(&self) -> &str {
        &self.pattern
    }

    pub fn matches(&self, scope: &ResourceScope) -> bool {
        if self.kind != scope.kind {
            return false;
        }
        if self.pattern == "*" {
            return true;
        }
        if let Some(prefix) = self.pattern.strip_suffix('*') {
            // prefix ends with '/', so "acme/" cannot match "acmex/".
            return scope.id.starts_with(prefix);
        }
        scope.id == self.pattern
    }
}

impl fmt::Display for ResourcePattern {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.kind, self.pattern)
    }
}

fn split_kind(raw: &str) -> Result<(ResourceKind, &str), IdError> {
    let (k, id) = raw.split_once(':').ok_or(IdError::Empty)?;
    let kind = ResourceKind::parse(k).ok_or(IdError::Char {
        kind: "resource kind",
        ch: k.chars().next().unwrap_or('?'),
        index: 0,
    })?;
    Ok((kind, id))
}

/// Validate a resource id.
///
/// The charset is deliberately
/// ASCII-printable minus shell/JSON/glob metacharacters: an id that needs escaping is
/// an id that will be escaped differently by four languages.
fn validate_id(id: &str, what: &'static str) -> Result<(), IdError> {
    if id.is_empty() {
        return Err(IdError::Empty);
    }
    if id.len() > 512 {
        return Err(IdError::Length {
            min: 1,
            max: 512,
            got: id.len(),
        });
    }
    for (i, b) in id.bytes().enumerate() {
        let printable = (0x21..=0x7e).contains(&b);
        let forbidden = matches!(
            b,
            b'"' | b'\\' | b'\'' | b'`' | b'<' | b'>' | b'{' | b'}' | b'|' | b'^' | b'[' | b']'
        );
        // '*' is handled by the caller (sole "*" or a trailing "/*"); anywhere else
        // it is a glob that would make exact matching a lie.
        if !printable || forbidden || b == b'*' {
            return Err(IdError::Char {
                kind: what,
                ch: b as char,
                index: i,
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod unit {
    use super::*;

    #[test]
    fn scope_never_accepts_a_star() {
        assert!(ResourceScope::new(ResourceKind::Repo, "acme/*").is_err());
        assert!(ResourcePattern::parse("repo:acme/*").is_ok());
    }

    #[test]
    fn display_round_trips_through_parse() {
        for raw in [
            "file:/srv/a b",
            "repo:acme/core",
            "http_origin:https://x.test",
        ] {
            if let Ok(s) = ResourceScope::parse(raw) {
                assert_eq!(ResourceScope::parse(&s.to_string()).unwrap(), s);
            }
        }
    }
}
