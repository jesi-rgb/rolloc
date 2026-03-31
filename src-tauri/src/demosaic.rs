//! AHD (Adaptive Homogeneity-Directed) Bayer demosaic.
//!
//! Produces a full-resolution RGB f32 image from a single-channel Bayer mosaic.
//! For non-Bayer CFA patterns (X-Trans 6×6, etc.) falls back to superpixel.
//!
//! Algorithm (Hirakawa & Parks, 2005):
//!   1. Interpolate green channel in two directions (H and V) using
//!      Hamilton-Adams Laplacian-corrected gradient-based interpolation.
//!   2. For each direction, interpolate red and blue on the green-interpolated
//!      plane using bilinear interpolation of colour differences (R−G, B−G).
//!   3. Convert both candidates to CIELab, measure local homogeneity in a 3×3
//!      neighbourhood, and select the candidate with higher homogeneity per pixel.

use rayon::prelude::*;

// ─── Public API ───────────────────────────────────────────────────────────────

/// Demosaic a Bayer CFA raw buffer to full-resolution RGB f32.
///
/// - `pixels`: flat u16 mosaic, one sample per photosite, row-major.
/// - `width`, `height`: sensor dimensions.
/// - `cfa_color_at`: closure returning 0 (R), 1 (G), 2 (B) for a given (row, col).
/// - `norm_ch`: closure normalising a raw u16 value for channel `ch` to [0, 1] f32
///              (black-subtracted, WB-scaled, clamped).
///
/// Returns `(out_width, out_height, Vec<f32>)` where out dimensions equal the
/// input minus a 3-pixel border on each side (AHD needs a 3-pixel kernel radius).
pub fn demosaic_ahd<F, N>(
    pixels: &[u16],
    width: usize,
    height: usize,
    cfa_color_at: F,
    norm_ch: N,
) -> (usize, usize, Vec<f32>)
where
    F: Fn(usize, usize) -> usize + Sync + Send,
    N: Fn(usize, f32) -> f32 + Sync + Send,
{
    // We need a 3-pixel border for the Hamilton-Adams green interpolation
    // (2nd-order Laplacian needs ±2) plus the 3×3 homogeneity window (±1).
    // Total border = 3 pixels on each side.
    let border = 3_usize;
    if width <= border * 2 || height <= border * 2 {
        // Image too small for AHD — return empty.
        return (0, 0, Vec::new());
    }

    let ow = width - border * 2;
    let oh = height - border * 2;

    // ── Step 0: Build normalised f32 mosaic ──────────────────────────────────
    // Pre-normalise the entire mosaic to avoid repeated work.
    let mut mosaic = vec![0.0_f32; width * height];
    for y in 0..height {
        for x in 0..width {
            let ch = cfa_color_at(y, x);
            mosaic[y * width + x] = norm_ch(ch, pixels[y * width + x] as f32);
        }
    }

    let m = |y: usize, x: usize| -> f32 { mosaic[y * width + x] };

    // ── Step 1: Green interpolation (Hamilton-Adams, H and V) ────────────────
    // For green photosites, green is known.
    // For R/B photosites, interpolate green in two directions.

    // Full-size green planes (only interior pixels matter, but allocate full).
    let mut green_h = vec![0.0_f32; width * height];
    let mut green_v = vec![0.0_f32; width * height];

    // Fill known green values and interpolate missing ones.
    // We need ±2 neighbours for the Laplacian correction, so start at y=2, x=2.
    for y in 2..height - 2 {
        for x in 2..width - 2 {
            let idx = y * width + x;
            let c = cfa_color_at(y, x);

            if c == 1 {
                // Green photosite — value is known.
                green_h[idx] = m(y, x);
                green_v[idx] = m(y, x);
            } else {
                // R or B photosite — interpolate green.
                let val = m(y, x);

                // Horizontal: average of left and right green neighbours,
                // corrected by the 2nd-order Laplacian of the current channel.
                let gh = (m(y, x - 1) + m(y, x + 1)) * 0.5
                    + (2.0 * val - m(y, x - 2) - m(y, x + 2)) * 0.25;

                // Vertical: average of top and bottom green neighbours,
                // corrected by the 2nd-order Laplacian of the current channel.
                let gv = (m(y - 1, x) + m(y + 1, x)) * 0.5
                    + (2.0 * val - m(y - 2, x) - m(y + 2, x)) * 0.25;

                green_h[idx] = gh.clamp(0.0, 1.0);
                green_v[idx] = gv.clamp(0.0, 1.0);
            }
        }
    }

    // ── Step 2: R/B interpolation on colour-difference plane ─────────────────
    // For each direction (H, V), compute R−G and B−G at known sites,
    // then bilinear-interpolate the differences at missing sites.

    // Full RGB planes for H and V candidates.
    let mut rgb_h = vec![0.0_f32; width * height * 3];
    let mut rgb_v = vec![0.0_f32; width * height * 3];

    // First pass: fill known values and green.
    for y in border..height - border {
        for x in border..width - border {
            let idx = y * width + x;
            let c = cfa_color_at(y, x);
            let val = m(y, x);

            // Green is already interpolated.
            rgb_h[idx * 3 + 1] = green_h[idx];
            rgb_v[idx * 3 + 1] = green_v[idx];

            if c == 0 {
                // Red photosite — red is known.
                rgb_h[idx * 3] = val;
                rgb_v[idx * 3] = val;
            } else if c == 2 {
                // Blue photosite — blue is known.
                rgb_h[idx * 3 + 2] = val;
                rgb_v[idx * 3 + 2] = val;
            }
            // Green photosites: R and B will be interpolated below.
        }
    }

    // Second pass: interpolate missing R and B using colour differences.
    // We interpolate (R−G) and (B−G) bilinearly, then add back green.
    //
    // For a Bayer pattern like RGGB:
    //   - At G sites in R rows: R is left/right avg, B is top/bottom avg
    //   - At G sites in B rows: B is left/right avg, R is top/bottom avg
    //   - At B sites: R is diagonal avg; at R sites: B is diagonal avg
    for y in border..height - border {
        for x in border..width - border {
            let idx = y * width + x;
            let c = cfa_color_at(y, x);

            // Process both H and V candidates identically for R/B interpolation
            // (the difference is only in the green channel).
            for (rgb, green) in [(&mut rgb_h, &green_h), (&mut rgb_v, &green_v)] {
                let g_here = green[idx];

                if c == 1 {
                    // Green photosite — need to interpolate both R and B.
                    // Determine which neighbours are R and which are B.
                    let c_top = cfa_color_at(y - 1, x);
                    let c_left = cfa_color_at(y, x - 1);

                    if c_top == 0 {
                        // R is above/below — interpolate R vertically, B horizontally.
                        let rd_t = m(y - 1, x) - green[idx - width];
                        let rd_b = m(y + 1, x) - green[idx + width];
                        let r_diff = (rd_t + rd_b) * 0.5;
                        rgb[idx * 3] = (g_here + r_diff).clamp(0.0, 1.0);

                        let bd_l = m(y, x - 1) - green[idx - 1];
                        let bd_r = m(y, x + 1) - green[idx + 1];
                        let b_diff = (bd_l + bd_r) * 0.5;
                        rgb[idx * 3 + 2] = (g_here + b_diff).clamp(0.0, 1.0);
                    } else if c_top == 2 {
                        // B is above/below — interpolate B vertically, R horizontally.
                        let bd_t = m(y - 1, x) - green[idx - width];
                        let bd_b = m(y + 1, x) - green[idx + width];
                        let b_diff = (bd_t + bd_b) * 0.5;
                        rgb[idx * 3 + 2] = (g_here + b_diff).clamp(0.0, 1.0);

                        let rd_l = m(y, x - 1) - green[idx - 1];
                        let rd_r = m(y, x + 1) - green[idx + 1];
                        let r_diff = (rd_l + rd_r) * 0.5;
                        rgb[idx * 3] = (g_here + r_diff).clamp(0.0, 1.0);
                    } else if c_left == 0 {
                        // R is left/right — interpolate R horizontally, B vertically.
                        let rd_l = m(y, x - 1) - green[idx - 1];
                        let rd_r = m(y, x + 1) - green[idx + 1];
                        let r_diff = (rd_l + rd_r) * 0.5;
                        rgb[idx * 3] = (g_here + r_diff).clamp(0.0, 1.0);

                        let bd_t = m(y - 1, x) - green[idx - width];
                        let bd_b = m(y + 1, x) - green[idx + width];
                        let b_diff = (bd_t + bd_b) * 0.5;
                        rgb[idx * 3 + 2] = (g_here + b_diff).clamp(0.0, 1.0);
                    } else {
                        // c_left == 2: B is left/right — interpolate B horizontally, R vertically.
                        let bd_l = m(y, x - 1) - green[idx - 1];
                        let bd_r = m(y, x + 1) - green[idx + 1];
                        let b_diff = (bd_l + bd_r) * 0.5;
                        rgb[idx * 3 + 2] = (g_here + b_diff).clamp(0.0, 1.0);

                        let rd_t = m(y - 1, x) - green[idx - width];
                        let rd_b = m(y + 1, x) - green[idx + width];
                        let r_diff = (rd_t + rd_b) * 0.5;
                        rgb[idx * 3] = (g_here + r_diff).clamp(0.0, 1.0);
                    }
                } else if c == 0 {
                    // Red photosite — need to interpolate B (diagonals).
                    let bd_tl = m(y - 1, x - 1) - green[(y - 1) * width + (x - 1)];
                    let bd_tr = m(y - 1, x + 1) - green[(y - 1) * width + (x + 1)];
                    let bd_bl = m(y + 1, x - 1) - green[(y + 1) * width + (x - 1)];
                    let bd_br = m(y + 1, x + 1) - green[(y + 1) * width + (x + 1)];
                    let b_diff = (bd_tl + bd_tr + bd_bl + bd_br) * 0.25;
                    rgb[idx * 3 + 2] = (g_here + b_diff).clamp(0.0, 1.0);
                } else {
                    // Blue photosite — need to interpolate R (diagonals).
                    let rd_tl = m(y - 1, x - 1) - green[(y - 1) * width + (x - 1)];
                    let rd_tr = m(y - 1, x + 1) - green[(y - 1) * width + (x + 1)];
                    let rd_bl = m(y + 1, x - 1) - green[(y + 1) * width + (x - 1)];
                    let rd_br = m(y + 1, x + 1) - green[(y + 1) * width + (x + 1)];
                    let r_diff = (rd_tl + rd_tr + rd_bl + rd_br) * 0.25;
                    rgb[idx * 3] = (g_here + r_diff).clamp(0.0, 1.0);
                }
            }
        }
    }

    // ── Step 3: Homogeneity-directed selection (CIELab, 3×3 window) ──────────
    // Convert both candidates to Lab, measure colour homogeneity, pick best.

    // Compute homogeneity maps for both directions (parallelised by row).
    let hom_h: Vec<u8> = vec![0u8; width * height];
    let hom_v: Vec<u8> = vec![0u8; width * height];

    // We'll compute homogeneity and build the output in one pass over the
    // output region to avoid allocating full Lab planes.
    let mut output = vec![0.0_f32; ow * oh * 3];

    // Homogeneity threshold — the epsilon for "similar" in Lab space.
    let eps_l = 2.0_f32;
    let eps_c = 2.0_f32;

    // Process rows in parallel.
    let row_chunks: Vec<&mut [f32]> = output.chunks_mut(ow * 3).collect();
    row_chunks
        .into_par_iter()
        .enumerate()
        .for_each(|(oy, row)| {
            let y = oy + border;
            for ox in 0..ow {
                let x = ox + border;

                // Compute Lab for both candidates at the center pixel.
                let idx = y * width + x;
                let lab_h_center =
                    rgb_to_lab(rgb_h[idx * 3], rgb_h[idx * 3 + 1], rgb_h[idx * 3 + 2]);
                let lab_v_center =
                    rgb_to_lab(rgb_v[idx * 3], rgb_v[idx * 3 + 1], rgb_v[idx * 3 + 2]);

                // Count homogeneous neighbours in a 3×3 window.
                let mut score_h = 0u32;
                let mut score_v = 0u32;

                for dy in -1i32..=1 {
                    for dx in -1i32..=1 {
                        let ny = (y as i32 + dy) as usize;
                        let nx = (x as i32 + dx) as usize;
                        let ni = ny * width + nx;

                        let lh = rgb_to_lab(rgb_h[ni * 3], rgb_h[ni * 3 + 1], rgb_h[ni * 3 + 2]);
                        let lv = rgb_to_lab(rgb_v[ni * 3], rgb_v[ni * 3 + 1], rgb_v[ni * 3 + 2]);

                        // H candidate homogeneity: neighbour is "similar" if
                        // both L and chroma distance are within epsilon.
                        let dl_h = (lh.0 - lab_h_center.0).abs();
                        let dc_h = ((lh.1 - lab_h_center.1).powi(2)
                            + (lh.2 - lab_h_center.2).powi(2))
                        .sqrt();
                        if dl_h < eps_l && dc_h < eps_c {
                            score_h += 1;
                        }

                        let dl_v = (lv.0 - lab_v_center.0).abs();
                        let dc_v = ((lv.1 - lab_v_center.1).powi(2)
                            + (lv.2 - lab_v_center.2).powi(2))
                        .sqrt();
                        if dl_v < eps_l && dc_v < eps_c {
                            score_v += 1;
                        }
                    }
                }

                // Pick the candidate with higher homogeneity.
                let base = ox * 3;
                if score_h >= score_v {
                    row[base] = rgb_h[idx * 3];
                    row[base + 1] = rgb_h[idx * 3 + 1];
                    row[base + 2] = rgb_h[idx * 3 + 2];
                } else {
                    row[base] = rgb_v[idx * 3];
                    row[base + 1] = rgb_v[idx * 3 + 1];
                    row[base + 2] = rgb_v[idx * 3 + 2];
                }
            }
        });

    drop(hom_h);
    drop(hom_v);

    (ow, oh, output)
}

/// Superpixel fallback for non-Bayer CFA patterns (X-Trans, etc.).
///
/// Averages all photosites of each colour within each CFA tile.
/// Output size: `(width / cfa_w, height / cfa_h)`.
pub fn demosaic_superpixel<F, N>(
    pixels: &[u16],
    width: usize,
    height: usize,
    cfa_w: usize,
    cfa_h: usize,
    cfa_color_at: F,
    norm_ch: N,
) -> (usize, usize, Vec<f32>)
where
    F: Fn(usize, usize) -> usize + Sync + Send,
    N: Fn(usize, f32) -> f32 + Sync + Send,
{
    let tiles_x = width / cfa_w;
    let tiles_y = height / cfa_h;
    let ow = tiles_x;
    let oh = tiles_y;
    let mut buf = vec![0.0_f32; ow * oh * 3];

    for ty in 0..oh {
        for tx in 0..ow {
            let origin_y = ty * cfa_h;
            let origin_x = tx * cfa_w;

            let mut r_sum = 0.0_f32;
            let mut r_cnt = 0u32;
            let mut g_sum = 0.0_f32;
            let mut g_cnt = 0u32;
            let mut b_sum = 0.0_f32;
            let mut b_cnt = 0u32;

            for dy in 0..cfa_h {
                for dx in 0..cfa_w {
                    let py = origin_y + dy;
                    let px_coord = origin_x + dx;
                    let c = cfa_color_at(dy, dx);
                    let v = norm_ch(c, pixels[py * width + px_coord] as f32);
                    match c {
                        0 => {
                            r_sum += v;
                            r_cnt += 1;
                        }
                        2 => {
                            b_sum += v;
                            b_cnt += 1;
                        }
                        _ => {
                            g_sum += v;
                            g_cnt += 1;
                        }
                    }
                }
            }

            let r = if r_cnt > 0 { r_sum / r_cnt as f32 } else { 0.0 };
            let g = if g_cnt > 0 { g_sum / g_cnt as f32 } else { 0.0 };
            let b = if b_cnt > 0 { b_sum / b_cnt as f32 } else { 0.0 };

            let base = (ty * ow + tx) * 3;
            buf[base] = r;
            buf[base + 1] = g;
            buf[base + 2] = b;
        }
    }

    (ow, oh, buf)
}

// ─── CIELab conversion ───────────────────────────────────────────────────────

/// Convert linear sRGB [0,1] to CIELab (L, a, b).
/// Uses D65 reference white (0.95047, 1.0, 1.08883).
#[inline(always)]
fn rgb_to_lab(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    // Linear sRGB → XYZ (D65)
    let x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
    let y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
    let z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b;

    // Normalise by D65 white point.
    let xn = x / 0.95047;
    let yn = y; // / 1.0
    let zn = z / 1.08883;

    let fx = lab_f(xn);
    let fy = lab_f(yn);
    let fz = lab_f(zn);

    let l = 116.0 * fy - 16.0;
    let a = 500.0 * (fx - fy);
    let b_val = 200.0 * (fy - fz);

    (l, a, b_val)
}

/// CIELab transfer function.
#[inline(always)]
fn lab_f(t: f32) -> f32 {
    let delta: f32 = 6.0 / 29.0;
    if t > delta * delta * delta {
        t.cbrt()
    } else {
        t / (3.0 * delta * delta) + 4.0 / 29.0
    }
}
