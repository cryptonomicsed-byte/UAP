//! Budgets: what one task may consume, and the ledger that enforces it.
//!
//! Every counter is an integer and every addition is checked. A policy kernel that
//! wraps a `u64` turns "this task overspent by 2^64 micro-USD" into "this task spent
//! nothing", so overflow is an error, never a value.

use core::fmt;

use crate::canonical::CanonicalWriter;

/// Requested spend for one intent. All fields are cumulative ceilings, not estimates.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Spend {
    pub cpu_ms: u64,
    /// Peak resident memory expected, MiB.
    pub ram_mib: u64,
    pub gpu_ms: u64,
    /// Cloud spend in micro-units of the billing currency (1e-6), so $0.000001 is 1.
    pub cloud_micros: u64,
    /// Event-bus / trigger budget.
    pub events: u64,
}

impl Spend {
    pub const fn zero() -> Self {
        Self {
            cpu_ms: 0,
            ram_mib: 0,
            gpu_ms: 0,
            cloud_micros: 0,
            events: 0,
        }
    }

    /// Checked component-wise addition. `None` on overflow of any counter.
    pub fn checked_add(&self, other: &Spend) -> Option<Self> {
        Some(Self {
            cpu_ms: self.cpu_ms.checked_add(other.cpu_ms)?,
            ram_mib: self.ram_mib.checked_add(other.ram_mib)?,
            gpu_ms: self.gpu_ms.checked_add(other.gpu_ms)?,
            cloud_micros: self.cloud_micros.checked_add(other.cloud_micros)?,
            events: self.events.checked_add(other.events)?,
        })
    }

    pub fn is_zero(&self) -> bool {
        *self == Self::zero()
    }

    /// Field-by-field `self <= ceiling`. Returns the names of counters that exceed it,
    /// in canonical order, so a denial can say exactly which ceiling was hit.
    pub fn exceeds(&self, ceiling: &Spend) -> Vec<&'static str> {
        let mut over = Vec::new();
        if self.cpu_ms > ceiling.cpu_ms {
            over.push("cpu_ms");
        }
        if self.ram_mib > ceiling.ram_mib {
            over.push("ram_mib");
        }
        if self.gpu_ms > ceiling.gpu_ms {
            over.push("gpu_ms");
        }
        if self.cloud_micros > ceiling.cloud_micros {
            over.push("cloud_micros");
        }
        if self.events > ceiling.events {
            over.push("events");
        }
        over
    }

    pub(crate) fn write_into(&self, w: &mut CanonicalWriter) {
        w.begin_object("spend");
        w.field_int("cpu_ms", self.cpu_ms);
        w.field_int("ram_mib", self.ram_mib);
        w.field_int("gpu_ms", self.gpu_ms);
        w.field_int("cloud_micros", self.cloud_micros);
        w.field_int("events", self.events);
        w.end_object();
    }
}

impl fmt::Display for Spend {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "cpu={}ms ram={}MiB gpu={}ms cloud={}u events={}",
            self.cpu_ms, self.ram_mib, self.gpu_ms, self.cloud_micros, self.events
        )
    }
}

/// Per-task ceilings a grant confers.
///
/// `concurrency` is enforced by the admission ledger per `(tenant, sid)`;
/// `wall_ms` bounds one task's lifetime; `spend` bounds the aggregate the task may
/// reserve. All three are ceilings, never entitlements.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Budget {
    pub concurrency: u32,
    pub wall_ms: u64,
    pub spend: Spend,
}

impl Budget {
    pub(crate) fn write_into(&self, w: &mut CanonicalWriter) {
        w.begin_object("budget");
        w.field_int("concurrency", u64::from(self.concurrency));
        w.field_int("wall_ms", self.wall_ms);
        self.spend.write_into(w);
        w.end_object();
    }
}

impl fmt::Display for Budget {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "concurrency={} wall={}ms ({})",
            self.concurrency, self.wall_ms, self.spend
        )
    }
}
