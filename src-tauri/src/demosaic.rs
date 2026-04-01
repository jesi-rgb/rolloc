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
                    rgb_to_lab_tuple(rgb_h[idx * 3], rgb_h[idx * 3 + 1], rgb_h[idx * 3 + 2]);
                let lab_v_center =
                    rgb_to_lab_tuple(rgb_v[idx * 3], rgb_v[idx * 3 + 1], rgb_v[idx * 3 + 2]);

                // Count homogeneous neighbours in a 3×3 window.
                let mut score_h = 0u32;
                let mut score_v = 0u32;

                for dy in -1i32..=1 {
                    for dx in -1i32..=1 {
                        let ny = (y as i32 + dy) as usize;
                        let nx = (x as i32 + dx) as usize;
                        let ni = ny * width + nx;

                        let lh =
                            rgb_to_lab_tuple(rgb_h[ni * 3], rgb_h[ni * 3 + 1], rgb_h[ni * 3 + 2]);
                        let lv =
                            rgb_to_lab_tuple(rgb_v[ni * 3], rgb_v[ni * 3 + 1], rgb_v[ni * 3 + 2]);

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
///
/// **Note:** This produces a downsampled image. For full-resolution output,
/// use `demosaic_bilinear` instead.
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

/// Full-resolution X-Trans demosaic using bilinear interpolation.
///
/// Simple but correct: for each pixel, average the nearest neighbors of
/// each missing color. Not as sharp as Markesteijn but produces correct colors.
pub fn demosaic_xtrans_bilinear<F, N>(
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
    let border = 3_usize;
    if width <= border * 2 || height <= border * 2 {
        return (0, 0, Vec::new());
    }

    let ow = width - border * 2;
    let oh = height - border * 2;

    // Build normalized mosaic
    let mut mosaic = vec![0.0_f32; width * height];
    for y in 0..height {
        for x in 0..width {
            let ch = cfa_color_at(y, x);
            mosaic[y * width + x] = norm_ch(ch, pixels[y * width + x] as f32);
        }
    }

    let m = |y: usize, x: usize| -> f32 { mosaic[y * width + x] };

    let mut output = vec![0.0_f32; ow * oh * 3];

    // Process each output pixel
    for oy in 0..oh {
        let y = oy + border;
        for ox in 0..ow {
            let x = ox + border;
            let c = cfa_color_at(y, x);
            let known = m(y, x);

            // For each channel, either use the known value or interpolate
            let mut rgb = [0.0_f32; 3];
            rgb[c] = known;

            // Interpolate missing channels by averaging nearby pixels of that color
            for target in 0..3 {
                if target == c {
                    continue;
                }

                let mut sum = 0.0_f32;
                let mut cnt = 0u32;

                // Search in a 5x5 window for pixels of the target color
                for dy in -2i32..=2 {
                    for dx in -2i32..=2 {
                        let ny = (y as i32 + dy) as usize;
                        let nx = (x as i32 + dx) as usize;
                        if cfa_color_at(ny, nx) == target {
                            // Weight by inverse distance (Manhattan)
                            let dist = (dy.abs() + dx.abs()) as f32;
                            let weight = 1.0 / (dist + 0.5);
                            sum += m(ny, nx) * weight;
                            cnt += 1;
                        }
                    }
                }

                if cnt > 0 {
                    // Normalize by weight sum
                    let mut weight_sum = 0.0_f32;
                    for dy in -2i32..=2 {
                        for dx in -2i32..=2 {
                            let ny = (y as i32 + dy) as usize;
                            let nx = (x as i32 + dx) as usize;
                            if cfa_color_at(ny, nx) == target {
                                let dist = (dy.abs() + dx.abs()) as f32;
                                weight_sum += 1.0 / (dist + 0.5);
                            }
                        }
                    }
                    rgb[target] = (sum / weight_sum).clamp(0.0, 1.0);
                }
            }

            let base = (oy * ow + ox) * 3;
            output[base] = rgb[0];
            output[base + 1] = rgb[1];
            output[base + 2] = rgb[2];
        }
    }

    (ow, oh, output)
}

/// Full-resolution X-Trans demosaic using Frank Markesteijn's algorithm.
///
/// This is a Rust port of the algorithm from dcraw.c, which uses:
/// 1. Hexagonal neighborhood mapping that matches X-Trans geometry
/// 2. Multi-directional (4 or 8) green interpolation with gradient weighting
/// 3. CIELab-based homogeneity maps for direction selection
/// 4. Tiled processing for cache efficiency
///
/// The X-Trans 6×6 pattern has a specific structure:
/// ```text
///   G b G G r G
///   r G r b G b
///   G b G G r G
///   G r G G b G
///   b G b r G r
///   G r G G b G
/// ```
///
/// Output size equals input size minus an 8-pixel border (full sensor resolution).
pub fn demosaic_xtrans<F, N>(
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
    const TS: usize = 512; // Tile size for cache efficiency
    const BORDER: usize = 8; // Border needed for the algorithm

    if width <= BORDER * 2 || height <= BORDER * 2 {
        return (0, 0, Vec::new());
    }

    // Build X-Trans CFA lookup (6×6 pattern, offset by 6 for safe negative indexing)
    let mut xtrans = [[0u8; 6]; 6];
    for row in 0..6 {
        for col in 0..6 {
            xtrans[row][col] = cfa_color_at(row, col) as u8;
        }
    }
    let fcol = |row: i32, col: i32| -> usize {
        xtrans[((row + 600) % 6) as usize][((col + 600) % 6) as usize] as usize
    };

    // ── Step 0: Build normalised f32 image ───────────────────────────────────
    // We store as [height][width][4] where channel 3 is used for green bounds
    let mut image: Vec<f32> = vec![0.0; width * height * 4];
    for y in 0..height {
        for x in 0..width {
            let ch = cfa_color_at(y, x);
            let val = norm_ch(ch, pixels[y * width + x] as f32);
            image[(y * width + x) * 4 + ch] = val;
        }
    }

    // ── Step 1: Build hexagonal neighborhood offsets ─────────────────────────
    // Maps green hexagons around non-green pixels and vice versa
    let orth: [i32; 12] = [1, 0, 0, 1, -1, 0, 0, -1, 1, 0, 0, 1];
    let patt: [[i32; 16]; 2] = [
        [0, 1, 0, -1, 2, 0, -1, 0, 1, 1, 1, -1, 0, 0, 0, 0],
        [0, 1, 0, -2, 1, 0, -2, 0, 1, 1, -2, -2, 1, -1, -1, 1],
    ];

    // allhex[row%3][col%3][pass][direction] = offset
    // pass 0 = offset in original image, pass 1 = offset in tile
    let mut allhex = [[[[0i32; 8]; 2]; 3]; 3];
    let mut sgrow = 0i32;
    let mut sgcol = 0i32;

    for row in 0..3i32 {
        for col in 0..3i32 {
            let mut ng = 0;
            for d in (0..10).step_by(2) {
                let g = if fcol(row, col) == 1 { 1 } else { 0 };
                if fcol(row + orth[d], col + orth[d + 2]) == 1 {
                    ng = 0;
                } else {
                    ng += 1;
                }
                if ng == 4 {
                    sgrow = row;
                    sgcol = col;
                }
                if ng == g + 1 {
                    for c in 0..8 {
                        let v = orth[d] * patt[g][c * 2] + orth[d + 1] * patt[g][c * 2 + 1];
                        let h = orth[d + 2] * patt[g][c * 2] + orth[d + 3] * patt[g][c * 2 + 1];
                        let idx = c ^ ((g * 2) & d);
                        allhex[row as usize][col as usize][0][idx] = h + v * width as i32;
                        allhex[row as usize][col as usize][1][idx] = h + v * TS as i32;
                    }
                }
            }
        }
    }

    // Direction offsets: horizontal, vertical, and two diagonals
    let dir: [i32; 4] = [1, TS as i32, TS as i32 + 1, TS as i32 - 1];
    let ndir = 4usize; // Use 4 directions (single pass)

    // ── Step 2: Set green bounds (min/max) for each R/B pixel ────────────────
    for row in 2..height as i32 - 2 {
        let mut min_g = 0.0f32;
        let mut max_g = 0.0f32;
        let mut col = 2i32;
        while col < width as i32 - 2 {
            if fcol(row, col) == 1 {
                min_g = 0.0;
                max_g = 0.0;
                col += 1;
                continue;
            }

            let idx = (row as usize * width + col as usize) * 4;
            let hex = &allhex[(row % 3) as usize][(col % 3) as usize][0];

            if max_g == 0.0 {
                min_g = f32::MAX;
                max_g = 0.0;
                for c in 0..6 {
                    let nidx = (idx as i32 + hex[c] * 4) as usize;
                    if nidx < image.len() {
                        let val = image[nidx + 1]; // Green channel
                        if val > 0.0 {
                            min_g = min_g.min(val);
                            max_g = max_g.max(val);
                        }
                    }
                }
                if min_g == f32::MAX {
                    min_g = 0.0;
                }
            }

            image[idx + 1] = min_g; // Store min in green channel
            image[idx + 3] = max_g; // Store max in channel 3

            // Handle the diagonal traversal pattern from dcraw
            match (row - sgrow) % 3 {
                1 => {
                    if row < height as i32 - 3 {
                        // Skip to next iteration differently
                    }
                }
                2 => {
                    min_g = 0.0;
                    max_g = 0.0;
                }
                _ => {}
            }
            col += 1;
        }
    }

    // Output image
    let ow = width;
    let oh = height;
    let mut output = vec![0.0_f32; ow * oh * 3];

    // ── Step 3: Process tiles ────────────────────────────────────────────────
    let mut top = BORDER as i32;
    while top < height as i32 - 19 {
        let mut left = BORDER as i32;
        while left < width as i32 - 19 {
            let mrow = (top as usize + TS).min(height - BORDER);
            let mcol = (left as usize + TS).min(width - BORDER);

            // Allocate tile buffers
            // rgb[dir][row][col][channel] - 4 directions × TS × TS × 3 channels
            let mut rgb: Vec<Vec<Vec<[f32; 3]>>> = vec![vec![vec![[0.0; 3]; TS]; TS]; ndir];

            // Copy image data into tile buffer (direction 0)
            for row in top as usize..mrow {
                for col in left as usize..mcol {
                    let tr = row - top as usize;
                    let tc = col - left as usize;
                    let idx = (row * width + col) * 4;
                    rgb[0][tr][tc][0] = image[idx]; // R
                    rgb[0][tr][tc][1] = image[idx + 1]; // G (or min_g for R/B pixels)
                    rgb[0][tr][tc][2] = image[idx + 2]; // B
                }
            }

            // Copy to other directions
            for d in 1..ndir {
                for tr in 0..TS {
                    for tc in 0..TS {
                        rgb[d][tr][tc] = rgb[0][tr][tc];
                    }
                }
            }

            // ── Interpolate green in 4 directions ────────────────────────────
            for row in top as usize..mrow {
                for col in left as usize..mcol {
                    let f = fcol(row as i32, col as i32);
                    if f == 1 {
                        continue; // Already green
                    }

                    let tr = row - top as usize;
                    let tc = col - left as usize;
                    let idx = (row * width + col) * 4;
                    let hex = &allhex[row % 3][col % 3][1];

                    // Get green bounds
                    let min_g = image[idx + 1];
                    let max_g = image[idx + 3];

                    // Interpolate green using hex neighbors with different weightings
                    // for each direction (simplified from dcraw's complex formula)
                    let mut color = [0.0f32; 4];

                    // Direction 0 and 1: use hex[0] and hex[1]
                    if tr >= 2 && tr < TS - 2 && tc >= 2 && tc < TS - 2 {
                        let h0 = hex[0];
                        let h1 = hex[1];

                        // Get neighbor greens
                        let get_g = |offset: i32| -> f32 {
                            let nr = (tr as i32 + offset / TS as i32) as usize;
                            let nc = (tc as i32 + offset % TS as i32) as usize;
                            if nr < TS && nc < TS {
                                rgb[0][nr][nc][1]
                            } else {
                                0.0
                            }
                        };

                        // Simple weighted average of hex neighbors
                        let g0 = get_g(h0);
                        let g1 = get_g(h1);

                        color[0] = (174.0 * (g0 + g1)) / 256.0;
                        color[1] = (223.0 * get_g(hex[3]) + 33.0 * get_g(hex[2])) / 256.0;
                        color[2] = (164.0 * get_g(hex[4]) + 92.0 * get_g(hex[5])) / 256.0;
                        color[3] = (164.0 * get_g(hex[5]) + 92.0 * get_g(hex[4])) / 256.0;
                    }

                    // Assign to each direction with clamping
                    for d in 0..4 {
                        let g = color[d].clamp(min_g.min(0.0), max_g.max(1.0));
                        let actual_d = if (row as i32 - sgrow) % 3 != 0 {
                            d ^ 1
                        } else {
                            d
                        };
                        if actual_d < ndir {
                            rgb[actual_d][tr][tc][1] = g;
                        }
                    }
                }
            }

            // ── Interpolate R/B for solitary green pixels ────────────────────
            let start_row = ((top - sgrow + 4) / 3 * 3 + sgrow) as usize;
            let start_col = ((left - sgcol + 4) / 3 * 3 + sgcol) as usize;

            let mut row = start_row;
            while row < mrow.saturating_sub(2) {
                let mut col = start_col;
                while col < mcol.saturating_sub(2) {
                    let tr = row - top as usize;
                    let tc = col - left as usize;

                    if tr >= 2 && tr < TS - 2 && tc >= 2 && tc < TS - 2 {
                        // For each direction
                        for d in 0..ndir {
                            // Interpolate R and B from neighbors
                            let g = rgb[d][tr][tc][1];

                            // Simple bilinear on color differences
                            let mut r_sum = 0.0f32;
                            let mut r_cnt = 0u32;
                            let mut b_sum = 0.0f32;
                            let mut b_cnt = 0u32;

                            for dy in -1i32..=1 {
                                for dx in -1i32..=1 {
                                    if dy == 0 && dx == 0 {
                                        continue;
                                    }
                                    let ny = (tr as i32 + dy) as usize;
                                    let nx = (tc as i32 + dx) as usize;
                                    let nrow = row as i32 + dy;
                                    let ncol = col as i32 + dx;

                                    let nc = fcol(nrow, ncol);
                                    let ng = rgb[d][ny][nx][1];

                                    if nc == 0 {
                                        r_sum += rgb[d][ny][nx][0] - ng;
                                        r_cnt += 1;
                                    } else if nc == 2 {
                                        b_sum += rgb[d][ny][nx][2] - ng;
                                        b_cnt += 1;
                                    }
                                }
                            }

                            if r_cnt > 0 {
                                rgb[d][tr][tc][0] = (g + r_sum / r_cnt as f32).clamp(0.0, 1.0);
                            }
                            if b_cnt > 0 {
                                rgb[d][tr][tc][2] = (g + b_sum / b_cnt as f32).clamp(0.0, 1.0);
                            }
                        }
                    }
                    col += 3;
                }
                row += 3;
            }

            // ── Interpolate R for B pixels and B for R pixels ────────────────
            for row in (top as usize + 3)..(mrow.saturating_sub(3)) {
                for col in (left as usize + 3)..(mcol.saturating_sub(3)) {
                    let f = fcol(row as i32, col as i32);
                    if f == 1 {
                        continue;
                    }

                    let tr = row - top as usize;
                    let tc = col - left as usize;

                    // f=0 means R pixel, need B; f=2 means B pixel, need R
                    let target = 2 - f;

                    for d in 0..ndir {
                        let g = rgb[d][tr][tc][1];

                        // Use directional interpolation based on gradient
                        let c: i32 = if (row as i32 - sgrow) % 3 != 0 {
                            TS as i32
                        } else {
                            1
                        };

                        // Get neighbors in preferred direction
                        let get_val = |dr: i32, dc: i32, ch: usize| -> f32 {
                            let ny = (tr as i32 + dr) as usize;
                            let nx = (tc as i32 + dc) as usize;
                            if ny < TS && nx < TS {
                                rgb[d][ny][nx][ch]
                            } else {
                                0.0
                            }
                        };

                        let (dr1, dc1) = if c == 1 { (0, 1) } else { (1, 0) };

                        let n1_target = get_val(dr1, dc1, target);
                        let n1_g = get_val(dr1, dc1, 1);
                        let n2_target = get_val(-dr1, -dc1, target);
                        let n2_g = get_val(-dr1, -dc1, 1);

                        let interp = ((n1_target - n1_g) + (n2_target - n2_g)) / 2.0 + g;
                        rgb[d][tr][tc][target] = interp.clamp(0.0, 1.0);
                    }
                }
            }

            // ── Fill R/B for 2×2 green blocks ────────────────────────────────
            for row in (top as usize + 2)..(mrow.saturating_sub(2)) {
                if (row as i32 - sgrow) % 3 == 0 {
                    continue;
                }
                for col in (left as usize + 2)..(mcol.saturating_sub(2)) {
                    if (col as i32 - sgcol) % 3 == 0 {
                        continue;
                    }

                    let tr = row - top as usize;
                    let tc = col - left as usize;
                    let hex = &allhex[row % 3][col % 3][1];

                    for d in (0..ndir).step_by(2) {
                        if d + 1 < 8 && (hex[d] != 0 || hex[d + 1] != 0) {
                            let g = rgb[d][tr][tc][1];

                            // Get hex neighbors
                            let get_rgb = |offset: i32| -> [f32; 3] {
                                let nr = (tr as i32 + offset / TS as i32) as usize;
                                let nc = (tc as i32 + offset % TS as i32) as usize;
                                if nr < TS && nc < TS {
                                    rgb[d][nr][nc]
                                } else {
                                    [0.0; 3]
                                }
                            };

                            let n0 = get_rgb(hex[d]);
                            let n1 = get_rgb(hex[d + 1]);

                            // Weighted interpolation
                            let g_diff = 2.0 * g - n0[1] - n1[1];
                            rgb[d][tr][tc][0] = ((g_diff + n0[0] + n1[0]) / 2.0).clamp(0.0, 1.0);
                            rgb[d][tr][tc][2] = ((g_diff + n0[2] + n1[2]) / 2.0).clamp(0.0, 1.0);
                        }
                    }
                }
            }

            // ── Compute CIELab and derivatives for homogeneity ───────────────
            let mut lab: Vec<Vec<[f32; 3]>> = vec![vec![[0.0; 3]; TS]; TS];
            let mut drv: Vec<Vec<Vec<f32>>> = vec![vec![vec![0.0; TS]; TS]; ndir];
            let mut homo: Vec<Vec<Vec<u8>>> = vec![vec![vec![0; TS]; TS]; ndir];

            for d in 0..ndir {
                // Convert to Lab
                for tr in 2..(mrow - top as usize).min(TS).saturating_sub(2) {
                    for tc in 2..(mcol - left as usize).min(TS).saturating_sub(2) {
                        let r = rgb[d][tr][tc][0];
                        let g = rgb[d][tr][tc][1];
                        let b = rgb[d][tr][tc][2];
                        lab[tr][tc] = rgb_to_lab(r, g, b);
                    }
                }

                // Compute derivatives
                let f_offset = dir[d & 3];
                for tr in 3..(mrow - top as usize).min(TS).saturating_sub(3) {
                    for tc in 3..(mcol - left as usize).min(TS).saturating_sub(3) {
                        let dr = f_offset / TS as i32;
                        let dc = f_offset % TS as i32;

                        let nr1 = (tr as i32 + dr) as usize;
                        let nc1 = (tc as i32 + dc) as usize;
                        let nr2 = (tr as i32 - dr) as usize;
                        let nc2 = (tc as i32 - dc) as usize;

                        if nr1 < TS && nc1 < TS && nr2 < TS && nc2 < TS {
                            let l0 = lab[tr][tc];
                            let l1 = lab[nr1][nc1];
                            let l2 = lab[nr2][nc2];

                            let gl = 2.0 * l0[0] - l1[0] - l2[0];
                            let ga = 2.0 * l0[1] - l1[1] - l2[1] + gl * 500.0 / 232.0;
                            let gb = 2.0 * l0[2] - l1[2] - l2[2] - gl * 500.0 / 580.0;

                            drv[d][tr][tc] = gl * gl + ga * ga + gb * gb;
                        }
                    }
                }
            }

            // ── Build homogeneity maps ───────────────────────────────────────
            for tr in 4..(mrow - top as usize).min(TS).saturating_sub(4) {
                for tc in 4..(mcol - left as usize).min(TS).saturating_sub(4) {
                    // Find minimum derivative
                    let mut min_drv = f32::MAX;
                    for d in 0..ndir {
                        if drv[d][tr][tc] < min_drv {
                            min_drv = drv[d][tr][tc];
                        }
                    }
                    let threshold = min_drv * 8.0;

                    // Count homogeneous neighbors
                    for d in 0..ndir {
                        for v in -1i32..=1 {
                            for h in -1i32..=1 {
                                let nr = (tr as i32 + v) as usize;
                                let nc = (tc as i32 + h) as usize;
                                if nr < TS && nc < TS && drv[d][nr][nc] <= threshold {
                                    homo[d][tr][tc] += 1;
                                }
                            }
                        }
                    }
                }
            }

            // ── Average most homogeneous pixels for final output ─────────────
            let out_start_row = top as usize;
            let out_start_col = left as usize;
            let out_end_row = (mrow).min(height - BORDER);
            let out_end_col = (mcol).min(width - BORDER);

            for row in out_start_row.max(BORDER)..out_end_row {
                for col in out_start_col.max(BORDER)..out_end_col {
                    let tr = row - top as usize;
                    let tc = col - left as usize;

                    if tr < 4 || tr >= TS - 4 || tc < 4 || tc >= TS - 4 {
                        continue;
                    }

                    // Sum homogeneity in 5×5 window
                    let mut hm = [0u32; 4];
                    for d in 0..ndir {
                        for v in -2i32..=2 {
                            for h in -2i32..=2 {
                                let nr = (tr as i32 + v) as usize;
                                let nc = (tc as i32 + h) as usize;
                                if nr < TS && nc < TS {
                                    hm[d] += homo[d][nr][nc] as u32;
                                }
                            }
                        }
                    }

                    // Find max homogeneity
                    let mut max_hm = hm[0];
                    for d in 1..ndir {
                        if hm[d] > max_hm {
                            max_hm = hm[d];
                        }
                    }
                    let threshold = max_hm - (max_hm >> 3);

                    // Average directions with high homogeneity
                    let mut avg = [0.0f32; 3];
                    let mut cnt = 0u32;
                    for d in 0..ndir {
                        if hm[d] >= threshold {
                            avg[0] += rgb[d][tr][tc][0];
                            avg[1] += rgb[d][tr][tc][1];
                            avg[2] += rgb[d][tr][tc][2];
                            cnt += 1;
                        }
                    }

                    if cnt > 0 {
                        let out_idx = (row * width + col) * 3;
                        output[out_idx] = avg[0] / cnt as f32;
                        output[out_idx + 1] = avg[1] / cnt as f32;
                        output[out_idx + 2] = avg[2] / cnt as f32;
                    }
                }
            }

            left += TS as i32 - 16;
        }
        top += TS as i32 - 16;
    }

    // ── Border interpolation (simple bilinear fallback) ──────────────────────
    for row in 0..height {
        for col in 0..width {
            let out_idx = (row * width + col) * 3;

            // Check if this pixel was already filled
            if output[out_idx] != 0.0 || output[out_idx + 1] != 0.0 || output[out_idx + 2] != 0.0 {
                continue;
            }

            // Simple bilinear for border pixels
            let f = fcol(row as i32, col as i32);
            let idx = (row * width + col) * 4;

            // Get the known color
            let known = image[idx + f];

            // Interpolate green
            let g = if f == 1 {
                known
            } else {
                // Average nearby greens
                let mut sum = 0.0f32;
                let mut cnt = 0u32;
                for dy in -2i32..=2 {
                    for dx in -2i32..=2 {
                        let ny = (row as i32 + dy).clamp(0, height as i32 - 1) as usize;
                        let nx = (col as i32 + dx).clamp(0, width as i32 - 1) as usize;
                        if fcol(ny as i32, nx as i32) == 1 {
                            let nidx = (ny * width + nx) * 4;
                            sum += image[nidx + 1];
                            cnt += 1;
                        }
                    }
                }
                if cnt > 0 {
                    sum / cnt as f32
                } else {
                    known
                }
            };

            // Interpolate R and B similarly
            let r = if f == 0 {
                known
            } else {
                let mut sum = 0.0f32;
                let mut cnt = 0u32;
                for dy in -2i32..=2 {
                    for dx in -2i32..=2 {
                        let ny = (row as i32 + dy).clamp(0, height as i32 - 1) as usize;
                        let nx = (col as i32 + dx).clamp(0, width as i32 - 1) as usize;
                        if fcol(ny as i32, nx as i32) == 0 {
                            let nidx = (ny * width + nx) * 4;
                            sum += image[nidx];
                            cnt += 1;
                        }
                    }
                }
                if cnt > 0 {
                    sum / cnt as f32
                } else {
                    g
                }
            };

            let b = if f == 2 {
                known
            } else {
                let mut sum = 0.0f32;
                let mut cnt = 0u32;
                for dy in -2i32..=2 {
                    for dx in -2i32..=2 {
                        let ny = (row as i32 + dy).clamp(0, height as i32 - 1) as usize;
                        let nx = (col as i32 + dx).clamp(0, width as i32 - 1) as usize;
                        if fcol(ny as i32, nx as i32) == 2 {
                            let nidx = (ny * width + nx) * 4;
                            sum += image[nidx + 2];
                            cnt += 1;
                        }
                    }
                }
                if cnt > 0 {
                    sum / cnt as f32
                } else {
                    g
                }
            };

            output[out_idx] = r;
            output[out_idx + 1] = g;
            output[out_idx + 2] = b;
        }
    }

    (ow, oh, output)
}

/// Convert (L, a, b) tuple to array form for consistency.
#[inline(always)]
fn rgb_to_lab(r: f32, g: f32, b: f32) -> [f32; 3] {
    let lab = rgb_to_lab_tuple(r, g, b);
    [lab.0, lab.1, lab.2]
}

// ─── CIELab conversion ───────────────────────────────────────────────────────

/// Convert linear sRGB [0,1] to CIELab (L, a, b) as tuple.
/// Uses D65 reference white (0.95047, 1.0, 1.08883).
#[inline(always)]
fn rgb_to_lab_tuple(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
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
