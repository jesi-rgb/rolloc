/**
 * Straight-line detection for auto-straighten.
 *
 * Finds long, straight, near-horizontal or near-vertical edges and reports the
 * rotation that levels each one.
 *
 * Pipeline:
 *   1. Integer box-downsample to luma (pixels stay square, so angles survive)
 *   2. Binomial blur → Sobel gradients → non-maximum suppression (thin,
 *      sub-pixel edge points)
 *   3. Orientation-gated Hough vote: an edge point only votes for line angles
 *      within ORIENT_TOL of its own gradient direction, so texture (foliage,
 *      grain, clouds) cannot pile up votes on an arbitrary angle
 *   4. Peak picking, then a magnitude-weighted total-least-squares refit on
 *      the inliers of each peak's longest contiguous run
 *
 * All geometry is done in square-pixel space. Angles are never derived from
 * normalized (0–1) coordinates, which would scale them by the aspect ratio.
 *
 * Angle convention: `TransformParams.rotation` as rendered by transform.wgsl —
 * positive = counter-clockwise on screen. A candidate's `angle` is the delta to
 * add to the rotation the analysed image was rendered with.
 */

import type { Rect } from '$lib/types';

/** A detected line candidate for horizon/vertical straightening. */
export interface HorizonCandidate {
	/**
	 * Rotation delta in degrees (`TransformParams.rotation` units, positive =
	 * counter-clockwise) that levels this line when added to the rotation the
	 * analysed image was rendered with.
	 */
	angle: number;
	/** Detected segment endpoints, normalized 0–1 to the analysed image. */
	line: { x1: number; y1: number; x2: number; y2: number };
	/** Score relative to the best candidate (best = 1). */
	confidence: number;
	/** Whether the line should become horizontal or vertical. */
	type: 'horizontal' | 'vertical';
}

/** RGBA8 pixels, row-major, no padding (e.g. `GpuPipeline.readPixels()` output). */
export interface RgbaPixels {
	data: Uint8Array | Uint8ClampedArray;
	width: number;
	height: number;
}

export interface DetectionOptions {
	/** Long edge of the analysis image in px (default 720). */
	maxDimension?: number;
	/** Max tilt in degrees searched around horizontal/vertical (default 15). */
	angleRange?: number;
	/** Max number of candidates returned (default 4). */
	maxCandidates?: number;
	/** Normalized region to analyse (e.g. the crop); edges outside are ignored. */
	region?: Rect | null;
}

// ─── Tuning ───────────────────────────────────────────────────────────────────

/** Hough angle resolution (degrees per bin). The TLS refit gives the final precision. */
const THETA_STEP = 0.25;
/** Max disagreement (degrees) between an edge point's gradient and a voted line normal. */
const ORIENT_TOL = 3;
/** Same gate for refit inliers — slightly looser, the peak angle is approximate. */
const INLIER_COS = Math.cos((5 * Math.PI) / 180);
/** Absolute Sobel magnitude floor (≈ a 4-level step after blur): rejects flat-area noise. */
const MIN_EDGE_MAG = 10;
/** Keep the strongest (1 − EDGE_PERCENTILE) of the NMS edge points. */
const EDGE_PERCENTILE = 0.7;
/** Distance (analysis px) from a Hough line to count as an inlier. */
const PEAK_INLIER_DIST = 2;
/** Distance (analysis px) from the fitted line for the final refit. */
const FIT_INLIER_DIST = 1.25;
/** Max Hough peaks examined. */
const MAX_PEAKS = 24;
/** Peaks weaker than this fraction of the strongest are ignored. */
const PEAK_FLOOR = 0.08;
/** Peak suppression half-window: angle (degrees) and distance (fraction of diagonal). */
const SUPPRESS_DEG = 1.5;
const SUPPRESS_RHO = 0.015;
/** A gap longer than this (fraction of diagonal) splits a line into separate runs. */
const RUN_GAP = 0.08;
/** Minimum covered length as a fraction of the region's width (or height for verticals). */
const MIN_COVERAGE = 0.12;
/** Lines whose midpoint lies this close to the region edge are likely film rebate / holder. */
const BORDER_BAND = 0.04;
const BORDER_PENALTY = 0.35;
/** Verticals converge under perspective, so a single one is weaker evidence than a horizon. */
const VERTICAL_WEIGHT = 0.8;
/** Candidates whose angles differ by less than this (degrees) give the same rotation. */
const DUPLICATE_DEG = 0.3;
/** Candidates scoring below this fraction of the best are dropped. */
const MIN_CONFIDENCE = 0.25;
/** Pixels skipped along the image border (Sobel + NMS need neighbours). */
const EDGE_INSET = 2;

const TAN_22_5 = Math.tan(Math.PI / 8);
const DEG = Math.PI / 180;

type LineType = HorizonCandidate['type'];

interface Bounds {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

interface Edges {
	count: number;
	/** Sub-pixel position in analysis px. */
	x: Float32Array;
	y: Float32Array;
	/** Unit gradient direction. */
	nx: Float32Array;
	ny: Float32Array;
	mag: Float32Array;
	/** Magnitude threshold the edges passed; used to normalize vote weights. */
	threshold: number;
}

interface Scored {
	type: LineType;
	angle: number;
	/** Endpoints in analysis px. */
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	score: number;
}

// ─── Image preparation ───────────────────────────────────────────────────────

/** Box-average `factor`×`factor` blocks into BT.601 luma. */
function downsampleLuma(img: RgbaPixels, factor: number, w: number, h: number): Float32Array {
	const { data, width } = img;
	const luma = new Float32Array(w * h);
	const norm = 1 / (factor * factor);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			let sum = 0;
			for (let dy = 0; dy < factor; dy++) {
				let i = ((y * factor + dy) * width + x * factor) * 4;
				for (let dx = 0; dx < factor; dx++, i += 4) {
					sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
				}
			}
			luma[y * w + x] = sum * norm;
		}
	}
	return luma;
}

/** Separable [1 4 6 4 1]/16 binomial blur (σ ≈ 1), edges clamped. */
function blur5(src: Float32Array, w: number, h: number): Float32Array {
	const tmp = new Float32Array(w * h);
	const dst = new Float32Array(w * h);
	const clampX = (x: number): number => (x < 0 ? 0 : x >= w ? w - 1 : x);
	const clampY = (y: number): number => (y < 0 ? 0 : y >= h ? h - 1 : y);
	for (let y = 0; y < h; y++) {
		const r = y * w;
		for (let x = 0; x < w; x++) {
			tmp[r + x] =
				(src[r + clampX(x - 2)] +
					4 * src[r + clampX(x - 1)] +
					6 * src[r + x] +
					4 * src[r + clampX(x + 1)] +
					src[r + clampX(x + 2)]) /
				16;
		}
	}
	for (let y = 0; y < h; y++) {
		const rm2 = clampY(y - 2) * w;
		const rm1 = clampY(y - 1) * w;
		const r = y * w;
		const rp1 = clampY(y + 1) * w;
		const rp2 = clampY(y + 2) * w;
		for (let x = 0; x < w; x++) {
			dst[r + x] =
				(tmp[rm2 + x] + 4 * tmp[rm1 + x] + 6 * tmp[r + x] + 4 * tmp[rp1 + x] + tmp[rp2 + x]) /
				16;
		}
	}
	return dst;
}

/** Sobel → non-maximum suppression → sub-pixel edge points inside `roi`. */
function extractEdges(luma: Float32Array, w: number, h: number, roi: Bounds): Edges {
	const n = w * h;
	const gx = new Float32Array(n);
	const gy = new Float32Array(n);
	const mag = new Float32Array(n);
	for (let y = 1; y < h - 1; y++) {
		const r0 = (y - 1) * w;
		const r1 = y * w;
		const r2 = (y + 1) * w;
		for (let x = 1; x < w - 1; x++) {
			const a = luma[r0 + x - 1];
			const b = luma[r0 + x];
			const c = luma[r0 + x + 1];
			const d = luma[r1 + x - 1];
			const f = luma[r1 + x + 1];
			const g = luma[r2 + x - 1];
			const k = luma[r2 + x];
			const l = luma[r2 + x + 1];
			const sx = c + 2 * f + l - (a + 2 * d + g);
			const sy = g + 2 * k + l - (a + 2 * b + c);
			gx[r1 + x] = sx;
			gy[r1 + x] = sy;
			mag[r1 + x] = Math.hypot(sx, sy);
		}
	}

	const cap = (roi.x1 - roi.x0) * (roi.y1 - roi.y0);
	const px = new Float32Array(cap);
	const py = new Float32Array(cap);
	const pi = new Int32Array(cap);
	let count = 0;
	for (let y = roi.y0; y < roi.y1; y++) {
		for (let x = roi.x0; x < roi.x1; x++) {
			const i = y * w + x;
			const m = mag[i];
			if (m < MIN_EDGE_MAG) continue;
			const sx = gx[i];
			const sy = gy[i];
			const ax = Math.abs(sx);
			const ay = Math.abs(sy);
			// Quantize the gradient direction to one of four neighbour axes.
			let dx: number;
			let dy: number;
			if (ay <= ax * TAN_22_5) {
				dx = 1;
				dy = 0;
			} else if (ax <= ay * TAN_22_5) {
				dx = 0;
				dy = 1;
			} else {
				dx = 1;
				dy = sx > 0 === sy > 0 ? 1 : -1;
			}
			const m1 = mag[i - dy * w - dx];
			const m2 = mag[i + dy * w + dx];
			if (m < m1 || m <= m2) continue;
			// Parabolic peak through (−1, m1), (0, m), (+1, m2).
			const denom = m1 - 2 * m + m2;
			const off = denom < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (m1 - m2)) / denom)) : 0;
			px[count] = x + off * dx;
			py[count] = y + off * dy;
			pi[count] = i;
			count++;
		}
	}

	const sorted = new Float32Array(count);
	for (let j = 0; j < count; j++) sorted[j] = mag[pi[j]];
	sorted.sort();
	const threshold = Math.max(
		MIN_EDGE_MAG,
		count > 0 ? sorted[Math.floor(count * EDGE_PERCENTILE)] : 0,
	);

	const edges: Edges = {
		count: 0,
		x: new Float32Array(count),
		y: new Float32Array(count),
		nx: new Float32Array(count),
		ny: new Float32Array(count),
		mag: new Float32Array(count),
		threshold,
	};
	for (let j = 0; j < count; j++) {
		const i = pi[j];
		const m = mag[i];
		if (m < threshold) continue;
		const e = edges.count++;
		edges.x[e] = px[j];
		edges.y[e] = py[j];
		edges.nx[e] = gx[i] / m;
		edges.ny[e] = gy[i] / m;
		edges.mag[e] = m;
	}
	return edges;
}

// ─── Hough transform ──────────────────────────────────────────────────────────

/** Line normal angles θ (degrees) searched per family: 90° ± range or 0° ± range. */
function familyCenter(type: LineType): number {
	return type === 'horizontal' ? 90 : 0;
}

/** Deviation (degrees, [−90, 90)) of a gradient direction from a family's normal. */
function normalDeviation(nx: number, ny: number, type: LineType): number {
	const phi = Math.atan2(ny, nx) / DEG;
	const shift = type === 'horizontal' ? 0 : 90;
	return ((((phi + shift) % 180) + 180) % 180) - 90;
}

interface Accumulator {
	type: LineType;
	votes: Float32Array;
	nTheta: number;
	nRho: number;
	/** Offset added to rounded ρ to get its bin. */
	rhoHalf: number;
	angleRange: number;
}

/**
 * ρ = (x − cx)·cos θ + (y − cy)·sin θ, measured from the image centre.
 * Each edge point votes with weight ∝ its strength (capped) only for θ within
 * ORIENT_TOL of its own gradient direction.
 */
function houghVote(
	edges: Edges,
	type: LineType,
	angleRange: number,
	cx: number,
	cy: number,
	rhoHalf: number,
): Accumulator {
	const nTheta = Math.round((2 * angleRange) / THETA_STEP) + 1;
	const nRho = 2 * rhoHalf + 1;
	const votes = new Float32Array(nTheta * nRho);
	const cosT = new Float32Array(nTheta);
	const sinT = new Float32Array(nTheta);
	const base = familyCenter(type) - angleRange;
	for (let k = 0; k < nTheta; k++) {
		const t = (base + k * THETA_STEP) * DEG;
		cosT[k] = Math.cos(t);
		sinT[k] = Math.sin(t);
	}

	for (let e = 0; e < edges.count; e++) {
		const dev = normalDeviation(edges.nx[e], edges.ny[e], type);
		if (Math.abs(dev) > angleRange + ORIENT_TOL) continue;
		const kLo = Math.max(0, Math.ceil((dev - ORIENT_TOL + angleRange) / THETA_STEP));
		const kHi = Math.min(nTheta - 1, Math.floor((dev + ORIENT_TOL + angleRange) / THETA_STEP));
		const x = edges.x[e] - cx;
		const y = edges.y[e] - cy;
		const weight = Math.min(edges.mag[e] / edges.threshold, 2);
		for (let k = kLo; k <= kHi; k++) {
			const ri = Math.round(x * cosT[k] + y * sinT[k]) + rhoHalf;
			votes[k * nRho + ri] += weight;
		}
	}
	return { type, votes, nTheta, nRho, rhoHalf, angleRange };
}

interface Peak {
	type: LineType;
	/** Normal angle in degrees. */
	theta: number;
	rho: number;
}

/** Strongest accumulator cells across both families, with windowed suppression. */
function findPeaks(accs: Accumulator[], diag: number, minVotes: number): Peak[] {
	const work = accs.map((a) => a.votes.slice());
	const dTheta = Math.round(SUPPRESS_DEG / THETA_STEP);
	const dRho = Math.max(2, Math.round(SUPPRESS_RHO * diag));
	const peaks: Peak[] = [];
	let first = 0;

	while (peaks.length < MAX_PEAKS) {
		let best = 0;
		let bestAcc = -1;
		let bestIdx = -1;
		for (let a = 0; a < work.length; a++) {
			const v = work[a];
			for (let i = 0; i < v.length; i++) {
				if (v[i] > best) {
					best = v[i];
					bestAcc = a;
					bestIdx = i;
				}
			}
		}
		if (bestAcc < 0 || best < minVotes) break;
		if (peaks.length === 0) first = best;
		else if (best < first * PEAK_FLOOR) break;

		const acc = accs[bestAcc];
		const k = Math.floor(bestIdx / acc.nRho);
		const ri = bestIdx % acc.nRho;
		peaks.push({
			type: acc.type,
			theta: familyCenter(acc.type) - acc.angleRange + k * THETA_STEP,
			rho: ri - acc.rhoHalf,
		});

		const v = work[bestAcc];
		for (let kk = Math.max(0, k - dTheta); kk <= Math.min(acc.nTheta - 1, k + dTheta); kk++) {
			const row = kk * acc.nRho;
			for (let rr = Math.max(0, ri - dRho); rr <= Math.min(acc.nRho - 1, ri + dRho); rr++) {
				v[row + rr] = 0;
			}
		}
	}
	return peaks;
}

// ─── Line refit ───────────────────────────────────────────────────────────────

interface LineModel {
	/** Weighted centroid. */
	mx: number;
	my: number;
	/** Unit direction (major axis). */
	ux: number;
	uy: number;
}

/** Magnitude-weighted total least squares: major axis of the weighted scatter. */
function fitLine(edges: Edges, idx: number[]): LineModel {
	let sw = 0;
	let mx = 0;
	let my = 0;
	for (const e of idx) {
		const wgt = edges.mag[e];
		sw += wgt;
		mx += wgt * edges.x[e];
		my += wgt * edges.y[e];
	}
	mx /= sw;
	my /= sw;
	let sxx = 0;
	let syy = 0;
	let sxy = 0;
	for (const e of idx) {
		const wgt = edges.mag[e];
		const dx = edges.x[e] - mx;
		const dy = edges.y[e] - my;
		sxx += wgt * dx * dx;
		syy += wgt * dy * dy;
		sxy += wgt * dx * dy;
	}
	const a = 0.5 * Math.atan2(2 * sxy, sxx - syy);
	return { mx, my, ux: Math.cos(a), uy: Math.sin(a) };
}

/** Number of distinct 1-px bins covered by sorted positions along a line. */
function coverage(sortedT: number[]): number {
	let covered = 0;
	let last = Number.NEGATIVE_INFINITY;
	for (const t of sortedT) {
		const bin = Math.floor(t);
		if (bin !== last) {
			covered++;
			last = bin;
		}
	}
	return covered;
}

/**
 * Turn a Hough peak into a scored segment: gather gradient-consistent inliers,
 * keep the longest contiguous run, refit with TLS twice, and score it.
 */
function refinePeak(
	edges: Edges,
	peak: Peak,
	cx: number,
	cy: number,
	diag: number,
	roi: Bounds,
	angleRange: number,
): Scored | null {
	const nx = Math.cos(peak.theta * DEG);
	const ny = Math.sin(peak.theta * DEG);
	const inliers: { e: number; t: number }[] = [];
	for (let e = 0; e < edges.count; e++) {
		const x = edges.x[e] - cx;
		const y = edges.y[e] - cy;
		if (Math.abs(x * nx + y * ny - peak.rho) > PEAK_INLIER_DIST) continue;
		if (Math.abs(edges.nx[e] * nx + edges.ny[e] * ny) < INLIER_COS) continue;
		inliers.push({ e, t: -x * ny + y * nx });
	}
	if (inliers.length < 8) return null;
	inliers.sort((a, b) => a.t - b.t);

	// Split at gaps and keep the run covering the most length.
	const maxGap = RUN_GAP * diag;
	let bestRun: { e: number; t: number }[] = [];
	let bestCov = 0;
	let start = 0;
	for (let i = 1; i <= inliers.length; i++) {
		if (i < inliers.length && inliers[i].t - inliers[i - 1].t <= maxGap) continue;
		const run = inliers.slice(start, i);
		const cov = coverage(run.map((p) => p.t));
		if (cov > bestCov) {
			bestCov = cov;
			bestRun = run;
		}
		start = i;
	}
	if (bestRun.length < 8) return null;

	let idx = bestRun.map((p) => p.e);
	let model = fitLine(edges, idx);
	// One re-selection pass against the fitted line tightens the estimate.
	const tight = idx.filter(
		(e) =>
			Math.abs((edges.x[e] - model.mx) * -model.uy + (edges.y[e] - model.my) * model.ux) <=
			FIT_INLIER_DIST,
	);
	if (tight.length < 8) return null;
	idx = tight;
	model = fitLine(edges, idx);

	// Direction angle in y-down image space, (−90°, 90°].
	const dirDeg = Math.atan2(model.uy, model.ux) / DEG;
	const dir = dirDeg > 90 ? dirDeg - 180 : dirDeg <= -90 ? dirDeg + 180 : dirDeg;
	// A line sloping down-right (dir > 0) is levelled by turning the image
	// counter-clockwise, i.e. positive rotation. Same for verticals vs 90°.
	let angle: number;
	if (peak.type === 'horizontal') {
		if (Math.abs(dir) > 45) return null;
		angle = dir;
	} else {
		if (Math.abs(dir) < 45) return null;
		angle = dir > 0 ? dir - 90 : dir + 90;
	}
	if (Math.abs(angle) > angleRange) return null;

	const ts = idx
		.map((e) => (edges.x[e] - model.mx) * model.ux + (edges.y[e] - model.my) * model.uy)
		.sort((a, b) => a - b);
	const roiW = roi.x1 - roi.x0;
	const roiH = roi.y1 - roi.y0;
	const coverageFrac = coverage(ts) / (peak.type === 'horizontal' ? roiW : roiH);
	if (coverageFrac < MIN_COVERAGE) return null;

	// A real boundary keeps the same light/dark side along its length;
	// coincidentally collinear clutter does not.
	let positive = 0;
	for (const e of idx) {
		if (edges.nx[e] * -model.uy + edges.ny[e] * model.ux > 0) positive++;
	}
	const polarity = Math.max(positive, idx.length - positive) / idx.length;

	const tMin = ts[0];
	const tMax = ts[ts.length - 1];
	const x1 = model.mx + tMin * model.ux;
	const y1 = model.my + tMin * model.uy;
	const x2 = model.mx + tMax * model.ux;
	const y2 = model.my + tMax * model.uy;

	const across =
		peak.type === 'horizontal'
			? ((y1 + y2) / 2 - roi.y0) / roiH
			: ((x1 + x2) / 2 - roi.x0) / roiW;
	const borderFactor = across < BORDER_BAND || across > 1 - BORDER_BAND ? BORDER_PENALTY : 1;
	const typeWeight = peak.type === 'vertical' ? VERTICAL_WEIGHT : 1;

	return {
		type: peak.type,
		angle,
		x1,
		y1,
		x2,
		y2,
		score: coverageFrac * typeWeight * borderFactor * (0.5 + 0.5 * polarity),
	};
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/** Region of interest in analysis px, inset so Sobel/NMS neighbours exist. */
function regionBounds(region: Rect | null, w: number, h: number): Bounds {
	const r = region ?? { x: 0, y: 0, w: 1, h: 1 };
	return {
		x0: Math.max(EDGE_INSET, Math.floor(r.x * w)),
		y0: Math.max(EDGE_INSET, Math.floor(r.y * h)),
		x1: Math.min(w - EDGE_INSET, Math.ceil((r.x + r.w) * w)),
		y1: Math.min(h - EDGE_INSET, Math.ceil((r.y + r.h) * h)),
	};
}

/**
 * Detect straight horizon/vertical candidates in an RGBA image.
 *
 * @returns Candidates sorted best-first, each with a distinct rotation; empty
 *          when nothing long and straight enough is found.
 */
export function detectHorizonCandidates(
	img: RgbaPixels,
	options: DetectionOptions = {},
): HorizonCandidate[] {
	const maxDimension = options.maxDimension ?? 720;
	const angleRange = options.angleRange ?? 15;
	const maxCandidates = options.maxCandidates ?? 4;

	const factor = Math.max(1, Math.ceil(Math.max(img.width, img.height) / maxDimension));
	const w = Math.floor(img.width / factor);
	const h = Math.floor(img.height / factor);
	if (w < 16 || h < 16) return [];

	const roi = regionBounds(options.region ?? null, w, h);
	const roiW = roi.x1 - roi.x0;
	const roiH = roi.y1 - roi.y0;
	if (roiW < 16 || roiH < 16) return [];

	const luma = blur5(downsampleLuma(img, factor, w, h), w, h);
	const edges = extractEdges(luma, w, h, roi);
	if (edges.count === 0) return [];

	const cx = w / 2;
	const cy = h / 2;
	const diag = Math.hypot(w, h);
	const rhoHalf = Math.ceil(diag / 2) + 1;
	const accs = [
		houghVote(edges, 'horizontal', angleRange, cx, cy, rhoHalf),
		houghVote(edges, 'vertical', angleRange, cx, cy, rhoHalf),
	];
	// Votes ≥ 1 per edge point, so this is roughly half the minimum line length.
	const minVotes = 0.5 * MIN_COVERAGE * Math.min(roiW, roiH);
	const peaks = findPeaks(accs, diag, minVotes);

	const lines: Scored[] = [];
	for (const peak of peaks) {
		const line = refinePeak(edges, peak, cx, cy, diag, roi, angleRange);
		if (line) lines.push(line);
	}
	lines.sort((a, b) => b.score - a.score);

	const kept: Scored[] = [];
	for (const line of lines) {
		if (kept.some((k) => Math.abs(k.angle - line.angle) < DUPLICATE_DEG)) continue;
		kept.push(line);
	}
	if (kept.length === 0) return [];

	// Analysis px → normalized coords of the input image (pixel centres).
	const sx = factor / img.width;
	const sy = factor / img.height;
	const best = kept[0].score;
	return kept
		.filter((l) => l.score >= best * MIN_CONFIDENCE)
		.slice(0, maxCandidates)
		.map((l) => ({
			angle: l.angle,
			line: {
				x1: (l.x1 + 0.5) * sx,
				y1: (l.y1 + 0.5) * sy,
				x2: (l.x2 + 0.5) * sx,
				y2: (l.y2 + 0.5) * sy,
			},
			confidence: l.score / best,
			type: l.type,
		}));
}
