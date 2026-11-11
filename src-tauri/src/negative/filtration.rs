//! Print filtration: the CMY sliders as absolute density.
//!
//! Ported from NegPy 0.68 `filtration_offsets` (negpy/features/exposure/logic.py)
//! and the regional CMY scaling in `ExposureProcessor` (processor.py). Mirrors
//! src/lib/image/negative/filtration.ts; the white-balance picker is UI-only and
//! has no mirror here.

use super::constants::CMY_MAX_DENSITY;
use super::types::LogBounds;

/// Smallest channel range a division sees (NegPy `max(abs(range), 1e-6)`).
const MIN_RANGE: f32 = 1e-6;

fn finite_or_0(v: f32) -> f32 {
    if v.is_finite() {
        v
    } else {
        0.0
    }
}

/// Global CMY sliders as offsets added to the normalized value `u`:
/// `slider · CMY_MAX_DENSITY` is an absolute density (1.0 = 20cc), divided by
/// each channel's stretch range so the same slider prints the same filtration
/// on every frame and channel.
pub fn filtration_offsets(cmy: [f32; 3], bounds: &LogBounds) -> [f32; 3] {
    std::array::from_fn(|c| {
        let range = (bounds.ceils[c] - bounds.floors[c]).abs().max(MIN_RANGE);
        finite_or_0(cmy[c] * CMY_MAX_DENSITY / range)
    })
}

/// Shadow/highlight CMY sliders as absolute print density (processor.py, `* cmy_max`).
pub fn regional_cmy(cmy: [f32; 3]) -> [f32; 3] {
    cmy.map(|v| finite_or_0(v * CMY_MAX_DENSITY))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Same vectors as src/lib/image/negative/filtration.test.ts.
    /// Channel ranges 1.35, 0.9, 1.8 log D.
    const A: LogBounds = LogBounds {
        floors: [-1.5, -1.2, -1.0],
        ceils: [-0.15, -0.3, 0.8],
    };
    /// Slide-like (floor above ceil): ranges 2.0, 2.2, 2.3.
    const E6: LogBounds = LogBounds {
        floors: [0.0, -0.1, -0.2],
        ceils: [-2.0, -2.3, -2.5],
    };

    fn assert_vec(actual: [f32; 3], expected: [f32; 3]) {
        for c in 0..3 {
            assert!(
                (actual[c] - expected[c]).abs() < 1e-6,
                "channel {c}: {} vs {}",
                actual[c],
                expected[c]
            );
        }
    }

    #[test]
    fn offsets_divide_by_each_channel_range() {
        assert_vec(
            filtration_offsets([1.0, 1.0, 1.0], &A),
            [0.2 / 1.35, 0.2 / 0.9, 0.2 / 1.8],
        );
        assert_vec(
            filtration_offsets([-0.5, 0.25, 0.8], &A),
            [-0.074_074_074, 0.055_555_556, 0.088_888_889],
        );
    }

    #[test]
    fn same_slider_prints_same_absolute_density() {
        let off = filtration_offsets([1.0, 1.0, 1.0], &A);
        let ranges = [1.35, 0.9, 1.8];
        for c in 0..3 {
            assert!((off[c] * ranges[c] - 0.2).abs() < 1e-6);
        }
    }

    #[test]
    fn floor_above_ceil_keeps_slider_direction() {
        assert_vec(
            filtration_offsets([0.3, -0.7, 1.0], &E6),
            [0.03, -0.063_636_364, 0.086_956_522],
        );
    }

    #[test]
    fn neutral_sliders_give_no_offset() {
        assert_vec(filtration_offsets([0.0, 0.0, 0.0], &A), [0.0, 0.0, 0.0]);
    }

    #[test]
    fn regional_is_absolute_density() {
        assert_vec(regional_cmy([0.5, -1.0, 0.3]), [0.1, -0.2, 0.06]);
    }
}
