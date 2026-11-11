//! Shared data types of the negative pipeline. Mirror the TypeScript
//! definitions in src/lib/types.ts (`LogBounds`, `NeutralAxis`,
//! `NegativeAnalysis`, `AppliedBaseline`, `ANALYSIS_VERSION`).

use serde::{Deserialize, Serialize};

/// Version of the negative analysis (bounds + meters). Analyses stamped with
/// another version are ignored and re-measured.
pub const ANALYSIS_VERSION: u32 = 1;

/// Film processing mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilmType {
    /// Colour negative.
    C41,
    /// Black & white negative.
    Bw,
    /// Slide / reversal.
    E6,
}

impl FilmType {
    /// Parse the `filmType` string of `InversionParams`; anything unknown is a
    /// colour negative, the app default.
    pub fn parse(s: &str) -> Self {
        match s {
            "BW" => Self::Bw,
            "E6" => Self::E6,
            _ => Self::C41,
        }
    }
}

/// Per-channel log10-density window of a negative. `floors` is the dense end
/// (scene highlights, low log value), `ceils` the thin end (film base, high
/// log value). Normalization maps floor → 0 and ceil → 1.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq)]
pub struct LogBounds {
    pub floors: [f32; 3],
    pub ceils: [f32; 3],
}

/// Near-neutral reference densities of a frame: per-channel raw log10 values
/// of the lowest-chroma pixels in a midtone, shadow and (when present)
/// highlight luma band.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq)]
pub struct NeutralAxis {
    pub mid: [f32; 3],
    pub shadow: [f32; 3],
    pub highlight: Option<[f32; 3]>,
    /// How trustworthy the neutral sets are, 0–1.
    pub confidence: f32,
}

/// Everything measured from a frame's pixels that the print curve is solved
/// from.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NegativeAnalysis {
    pub version: u32,
    /// The frame's own bounds — never the roll mix.
    pub floors: [f32; 3],
    pub ceils: [f32; 3],
    /// Metered midtone in normalized luma, already pulled toward the assumed
    /// anchor and clamped.
    pub anchor: f32,
    /// Luma spread of the textured areas, in log10 density.
    pub textural_range: f32,
    pub neutral_axis: Option<NeutralAxis>,
    /// `AppliedBaseline::key` the meters were read against; `None` = the
    /// frame's own bounds.
    pub baseline_key: Option<f64>,
}

impl NegativeAnalysis {
    /// The frame's own bounds.
    pub fn bounds(&self) -> LogBounds {
        LogBounds {
            floors: self.floors,
            ceils: self.ceils,
        }
    }
}

/// A roll baseline as it applies to one frame.
#[derive(Deserialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppliedBaseline {
    pub floors: [f32; 3],
    pub ceils: [f32; 3],
    /// Take the roll's tonal range (luma-weighted centre and span).
    pub use_luma: bool,
    /// Take the roll's per-channel balance.
    pub use_color: bool,
    /// Unix ms of the roll analysis; identifies the baseline.
    pub key: f64,
}

impl AppliedBaseline {
    pub fn bounds(&self) -> LogBounds {
        LogBounds {
            floors: self.floors,
            ceils: self.ceils,
        }
    }
}
