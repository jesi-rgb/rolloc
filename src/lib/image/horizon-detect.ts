/**
 * Horizon line detection using Hough Transform.
 *
 * Detects dominant straight lines in an image and returns candidates
 * for auto-straightening. Supports both horizontal and vertical line detection.
 *
 * Algorithm:
 *   1. Grayscale conversion (luminance-weighted)
 *   2. Gaussian blur (3×3) to reduce noise
 *   3. Sobel edge detection (gradient magnitude + direction)
 *   4. Edge thresholding (keep strong edges)
 *   5. Hough Transform (accumulate votes in θ-ρ parameter space)
 *   6. Peak detection with non-maximum suppression
 *   7. Convert peaks to line candidates with angle + confidence
 */

/** A detected line candidate for horizon/vertical straightening. */
export interface HorizonCandidate {
	/** Angle deviation from reference in degrees. Positive = clockwise rotation needed. */
	angle: number;
	/** Line endpoints in normalized (0–1) coords. */
	line: { x1: number; y1: number; x2: number; y2: number };
	/** Confidence score (0–1) based on Hough vote count. */
	confidence: number;
	/** Whether this is a horizontal or vertical reference line. */
	type: 'horizontal' | 'vertical';
}

export interface DetectionOptions {
	/** Max dimension to downsample to (default: 800). Larger = slower but more precise. */
	maxDimension?: number;
	/** Edge magnitude threshold as fraction of max (default: 0.15). */
	edgeThreshold?: number;
	/** Max number of candidates to return (default: 5). */
	maxCandidates?: number;
	/** Angle range in degrees to search around horizontal/vertical (default: 45). */
	angleRange?: number;
}

const DEFAULT_OPTIONS: Required<DetectionOptions> = {
	maxDimension: 800,
	edgeThreshold: 0.15,
	maxCandidates: 5,
	angleRange: 45,
};

// ─── Image Processing Helpers ─────────────────────────────────────────────────

/**
 * Convert RGBA ImageData to grayscale Float32Array using luminance weights.
 */
function toGrayscale(data: Uint8ClampedArray, width: number, height: number): Float32Array {
	const gray = new Float32Array(width * height);
	for (let i = 0; i < width * height; i++) {
		const r = data[i * 4];
		const g = data[i * 4 + 1];
		const b = data[i * 4 + 2];
		// ITU-R BT.601 luminance weights
		gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
	}
	return gray;
}

/**
 * Apply 3×3 Gaussian blur to reduce noise.
 */
function gaussianBlur3x3(src: Float32Array, width: number, height: number): Float32Array {
	const dst = new Float32Array(width * height);
	// Gaussian kernel (σ ≈ 0.85): [1,2,1; 2,4,2; 1,2,1] / 16
	const kernel = [1, 2, 1, 2, 4, 2, 1, 2, 1];
	const kSum = 16;

	for (let y = 1; y < height - 1; y++) {
		for (let x = 1; x < width - 1; x++) {
			let sum = 0;
			let ki = 0;
			for (let ky = -1; ky <= 1; ky++) {
				for (let kx = -1; kx <= 1; kx++) {
					sum += src[(y + ky) * width + (x + kx)] * kernel[ki++];
				}
			}
			dst[y * width + x] = sum / kSum;
		}
	}
	return dst;
}

/**
 * Sobel edge detection. Returns gradient magnitude and direction.
 */
function sobelEdgeDetect(
	gray: Float32Array,
	width: number,
	height: number,
): { magnitude: Float32Array; direction: Float32Array; maxMag: number } {
	const magnitude = new Float32Array(width * height);
	const direction = new Float32Array(width * height);
	let maxMag = 0;

	// Sobel kernels
	// Gx: [-1,0,1; -2,0,2; -1,0,1]
	// Gy: [-1,-2,-1; 0,0,0; 1,2,1]

	for (let y = 1; y < height - 1; y++) {
		for (let x = 1; x < width - 1; x++) {
			const idx = y * width + x;

			// Compute Gx
			const gx =
				-gray[(y - 1) * width + (x - 1)] +
				gray[(y - 1) * width + (x + 1)] +
				-2 * gray[y * width + (x - 1)] +
				2 * gray[y * width + (x + 1)] +
				-gray[(y + 1) * width + (x - 1)] +
				gray[(y + 1) * width + (x + 1)];

			// Compute Gy
			const gy =
				-gray[(y - 1) * width + (x - 1)] +
				-2 * gray[(y - 1) * width + x] +
				-gray[(y - 1) * width + (x + 1)] +
				gray[(y + 1) * width + (x - 1)] +
				2 * gray[(y + 1) * width + x] +
				gray[(y + 1) * width + (x + 1)];

			const mag = Math.sqrt(gx * gx + gy * gy);
			magnitude[idx] = mag;
			direction[idx] = Math.atan2(gy, gx);
			if (mag > maxMag) maxMag = mag;
		}
	}

	return { magnitude, direction, maxMag };
}

// ─── Hough Transform ──────────────────────────────────────────────────────────

/**
 * Hough Transform for line detection.
 *
 * Each edge pixel votes for all lines (θ, ρ) that could pass through it.
 * Line equation: ρ = x·cos(θ) + y·sin(θ)
 *
 * We focus on angles near horizontal (θ ≈ 0° or 180°) and vertical (θ ≈ 90°).
 */
function houghTransform(
	magnitude: Float32Array,
	direction: Float32Array,
	width: number,
	height: number,
	threshold: number,
	angleRange: number,
): { accumulator: Uint32Array; thetaCount: number; rhoCount: number; rhoMax: number } {
	// θ resolution: 0.5° for precision
	const thetaStep = 0.5 * (Math.PI / 180);
	// We search two ranges: near-horizontal and near-vertical
	// Horizontal: θ ∈ [-angleRange, +angleRange]° around 0° and 180°
	// Vertical: θ ∈ [90-angleRange, 90+angleRange]°
	// Combined: we'll use θ ∈ [0, 180)° and mark which type each is

	const thetaCount = Math.ceil(180 / 0.5); // 360 bins for full 0-180°
	const rhoMax = Math.sqrt(width * width + height * height);
	const rhoStep = 1; // 1 pixel resolution
	const rhoCount = Math.ceil(2 * rhoMax / rhoStep);

	const accumulator = new Uint32Array(thetaCount * rhoCount);

	// Precompute sin/cos tables
	const cosTable = new Float32Array(thetaCount);
	const sinTable = new Float32Array(thetaCount);
	for (let ti = 0; ti < thetaCount; ti++) {
		const theta = ti * thetaStep;
		cosTable[ti] = Math.cos(theta);
		sinTable[ti] = Math.sin(theta);
	}

	// Vote for each edge pixel
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const idx = y * width + x;
			if (magnitude[idx] < threshold) continue;

			// Get edge direction and focus voting on perpendicular angles
			// (lines are perpendicular to gradient direction)
			const edgeDir = direction[idx];
			const lineAngle = edgeDir + Math.PI / 2; // perpendicular to gradient

			// Vote for angles near the edge-suggested line angle
			// This makes voting more focused and reduces noise
			for (let ti = 0; ti < thetaCount; ti++) {
				const theta = ti * thetaStep;

				// Weight by how close this theta is to the edge-suggested angle
				// (optional optimization - can skip for simpler implementation)
				const rho = x * cosTable[ti] + y * sinTable[ti];
				const rhoIdx = Math.round((rho + rhoMax) / rhoStep);

				if (rhoIdx >= 0 && rhoIdx < rhoCount) {
					accumulator[ti * rhoCount + rhoIdx]++;
				}
			}
		}
	}

	return { accumulator, thetaCount, rhoCount, rhoMax };
}

/**
 * Find peaks in the Hough accumulator with non-maximum suppression.
 */
function findPeaks(
	accumulator: Uint32Array,
	thetaCount: number,
	rhoCount: number,
	maxPeaks: number,
	angleRange: number,
): Array<{ theta: number; rho: number; votes: number; type: 'horizontal' | 'vertical' }> {
	const thetaStep = 0.5 * (Math.PI / 180);
	const peaks: Array<{ theta: number; rho: number; votes: number; type: 'horizontal' | 'vertical' }> = [];

	// Find global max for relative thresholding
	let globalMax = 0;
	for (let i = 0; i < accumulator.length; i++) {
		if (accumulator[i] > globalMax) globalMax = accumulator[i];
	}

	// Minimum votes to consider (10% of global max)
	const minVotes = globalMax * 0.1;

	// Suppression window size (in bins)
	const thetaWindow = Math.ceil(5 / 0.5); // ±5°
	const rhoWindow = 20; // ±20 pixels

	// Create a copy for suppression
	const suppressed = new Set<number>();

	// Angle ranges in theta bins:
	// Horizontal: theta near 0° or 180° → line angle ≈ 90° (perpendicular)
	// Actually, in Hough: θ is the angle of the normal to the line
	// So horizontal lines have θ ≈ 90° (normal points up/down)
	// Vertical lines have θ ≈ 0° or 180° (normal points left/right)
	const angleRangeRad = angleRange * (Math.PI / 180);

	// Horizontal lines: θ ∈ [90° - range, 90° + range]
	const horizMin = Math.floor((Math.PI / 2 - angleRangeRad) / thetaStep);
	const horizMax = Math.ceil((Math.PI / 2 + angleRangeRad) / thetaStep);

	// Vertical lines: θ ∈ [0, range] or [180° - range, 180°]
	const vertMin1 = 0;
	const vertMax1 = Math.ceil(angleRangeRad / thetaStep);
	const vertMin2 = Math.floor((Math.PI - angleRangeRad) / thetaStep);
	const vertMax2 = thetaCount - 1;

	function isHorizontalRange(ti: number): boolean {
		return ti >= horizMin && ti <= horizMax;
	}

	function isVerticalRange(ti: number): boolean {
		return (ti >= vertMin1 && ti <= vertMax1) || (ti >= vertMin2 && ti <= vertMax2);
	}

	// Find peaks
	while (peaks.length < maxPeaks * 2) { // Get extra, then filter
		let bestIdx = -1;
		let bestVotes = minVotes;

		for (let ti = 0; ti < thetaCount; ti++) {
			// Only consider angles in our ranges of interest
			if (!isHorizontalRange(ti) && !isVerticalRange(ti)) continue;

			for (let ri = 0; ri < rhoCount; ri++) {
				const idx = ti * rhoCount + ri;
				if (suppressed.has(idx)) continue;
				if (accumulator[idx] > bestVotes) {
					bestVotes = accumulator[idx];
					bestIdx = idx;
				}
			}
		}

		if (bestIdx === -1) break;

		const ti = Math.floor(bestIdx / rhoCount);
		const ri = bestIdx % rhoCount;
		const theta = ti * thetaStep;
		const rho = ri - Math.ceil(rhoCount / 2); // Center rho around 0

		const type = isHorizontalRange(ti) ? 'horizontal' : 'vertical';
		peaks.push({ theta, rho, votes: bestVotes, type });

		// Suppress neighborhood
		for (let dti = -thetaWindow; dti <= thetaWindow; dti++) {
			for (let dri = -rhoWindow; dri <= rhoWindow; dri++) {
				const nti = ti + dti;
				const nri = ri + dri;
				if (nti >= 0 && nti < thetaCount && nri >= 0 && nri < rhoCount) {
					suppressed.add(nti * rhoCount + nri);
				}
			}
		}
	}

	// Return top N of each type
	const horizontal = peaks.filter(p => p.type === 'horizontal').slice(0, maxPeaks);
	const vertical = peaks.filter(p => p.type === 'vertical').slice(0, maxPeaks);

	return [...horizontal, ...vertical];
}

/**
 * Convert a Hough peak (θ, ρ) to line endpoints in normalized coordinates.
 */
function peakToLine(
	theta: number,
	rho: number,
	width: number,
	height: number,
): { x1: number; y1: number; x2: number; y2: number } {
	const cosT = Math.cos(theta);
	const sinT = Math.sin(theta);

	// Line equation: x·cos(θ) + y·sin(θ) = ρ
	// Find intersections with image boundaries

	const points: Array<{ x: number; y: number }> = [];

	// Intersection with left edge (x = 0)
	if (Math.abs(sinT) > 1e-6) {
		const y = rho / sinT;
		if (y >= 0 && y <= height) points.push({ x: 0, y });
	}

	// Intersection with right edge (x = width)
	if (Math.abs(sinT) > 1e-6) {
		const y = (rho - width * cosT) / sinT;
		if (y >= 0 && y <= height) points.push({ x: width, y });
	}

	// Intersection with top edge (y = 0)
	if (Math.abs(cosT) > 1e-6) {
		const x = rho / cosT;
		if (x >= 0 && x <= width) points.push({ x, y: 0 });
	}

	// Intersection with bottom edge (y = height)
	if (Math.abs(cosT) > 1e-6) {
		const x = (rho - height * sinT) / cosT;
		if (x >= 0 && x <= width) points.push({ x, y: height });
	}

	// Take the two points that are furthest apart
	if (points.length < 2) {
		// Fallback: line doesn't intersect image bounds properly
		return { x1: 0, y1: 0.5, x2: 1, y2: 0.5 };
	}

	let maxDist = 0;
	let p1 = points[0];
	let p2 = points[1];
	for (let i = 0; i < points.length; i++) {
		for (let j = i + 1; j < points.length; j++) {
			const dx = points[j].x - points[i].x;
			const dy = points[j].y - points[i].y;
			const dist = dx * dx + dy * dy;
			if (dist > maxDist) {
				maxDist = dist;
				p1 = points[i];
				p2 = points[j];
			}
		}
	}

	// Normalize to 0–1
	return {
		x1: p1.x / width,
		y1: p1.y / height,
		x2: p2.x / width,
		y2: p2.y / height,
	};
}

/**
 * Calculate the rotation angle needed to straighten a line.
 *
 * For horizontal lines: angle from horizontal (0°)
 * For vertical lines: angle from vertical (90°)
 *
 * Returns the angle in degrees that should be applied to straighten.
 * Positive = clockwise rotation needed.
 */
function calculateStraightenAngle(
	line: { x1: number; y1: number; x2: number; y2: number },
	type: 'horizontal' | 'vertical',
): number {
	const dx = line.x2 - line.x1;
	const dy = line.y2 - line.y1;
	const lineAngle = Math.atan2(dy, dx) * (180 / Math.PI); // -180 to +180

	if (type === 'horizontal') {
		// Target is 0° (horizontal)
		// lineAngle near 0° or ±180° means nearly horizontal
		let deviation = lineAngle;
		if (deviation > 90) deviation -= 180;
		if (deviation < -90) deviation += 180;
		return -deviation; // Negate to get correction angle
	} else {
		// Target is 90° (vertical)
		// lineAngle near ±90° means nearly vertical
		let deviation = lineAngle;
		if (deviation > 0) {
			deviation = deviation - 90;
		} else {
			deviation = deviation + 90;
		}
		return -deviation;
	}
}

// ─── Main Detection Function ──────────────────────────────────────────────────

/**
 * Detect horizon/vertical line candidates in an image.
 *
 * @param imageData - Source image as ImageData (from canvas.getImageData or similar)
 * @param options - Detection options
 * @returns Array of line candidates sorted by confidence, or empty if none found
 */
export function detectHorizonCandidates(
	imageData: ImageData,
	options: DetectionOptions = {},
): HorizonCandidate[] {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const { width: srcWidth, height: srcHeight, data } = imageData;

	// 1. Downsample if needed
	let width = srcWidth;
	let height = srcHeight;
	let pixels = data;

	if (Math.max(srcWidth, srcHeight) > opts.maxDimension) {
		const scale = opts.maxDimension / Math.max(srcWidth, srcHeight);
		width = Math.round(srcWidth * scale);
		height = Math.round(srcHeight * scale);

		// Use OffscreenCanvas for downsampling
		const oc = new OffscreenCanvas(width, height);
		const ctx = oc.getContext('2d');
		if (!ctx) {
			console.error('[horizon-detect] Failed to create OffscreenCanvas context');
			return [];
		}

		// Create ImageBitmap from source data and draw scaled
		const srcCanvas = new OffscreenCanvas(srcWidth, srcHeight);
		const srcCtx = srcCanvas.getContext('2d');
		if (!srcCtx) return [];
		srcCtx.putImageData(imageData, 0, 0);

		ctx.drawImage(srcCanvas, 0, 0, width, height);
		pixels = ctx.getImageData(0, 0, width, height).data;
	}

	// 2. Convert to grayscale
	const gray = toGrayscale(pixels, width, height);

	// 3. Gaussian blur
	const blurred = gaussianBlur3x3(gray, width, height);

	// 4. Sobel edge detection
	const { magnitude, direction, maxMag } = sobelEdgeDetect(blurred, width, height);

	// 5. Edge thresholding
	const threshold = maxMag * opts.edgeThreshold;

	// 6. Hough Transform
	const { accumulator, thetaCount, rhoCount, rhoMax } = houghTransform(
		magnitude,
		direction,
		width,
		height,
		threshold,
		opts.angleRange,
	);

	// 7. Find peaks
	const peaks = findPeaks(accumulator, thetaCount, rhoCount, opts.maxCandidates, opts.angleRange);

	if (peaks.length === 0) {
		return [];
	}

	// 8. Convert peaks to candidates
	const maxVotes = Math.max(...peaks.map(p => p.votes));
	const candidates: HorizonCandidate[] = peaks.map(peak => {
		// Adjust rho back to actual coordinate space
		const actualRho = peak.rho + rhoMax;
		const line = peakToLine(peak.theta, actualRho, width, height);
		const angle = calculateStraightenAngle(line, peak.type);

		// Clamp angle to reasonable range
		const clampedAngle = Math.max(-45, Math.min(45, angle));

		return {
			angle: clampedAngle,
			line,
			confidence: peak.votes / maxVotes,
			type: peak.type,
		};
	});

	// Sort by confidence (highest first)
	candidates.sort((a, b) => b.confidence - a.confidence);

	// Filter out near-duplicate angles (within 1°)
	const filtered: HorizonCandidate[] = [];
	for (const c of candidates) {
		const isDuplicate = filtered.some(
			f => f.type === c.type && Math.abs(f.angle - c.angle) < 1,
		);
		if (!isDuplicate) {
			filtered.push(c);
		}
	}

	return filtered.slice(0, opts.maxCandidates);
}

/**
 * Create ImageData from a Uint8ClampedArray of RGBA pixels.
 * Useful when reading back from GPU via readPixels().
 */
export function createImageData(
	pixels: Uint8ClampedArray,
	width: number,
	height: number,
): ImageData {
	// Copy to a new Uint8ClampedArray backed by a plain ArrayBuffer
	// to satisfy ImageData constructor type requirements.
	const data = new Uint8ClampedArray(pixels);
	return new ImageData(data, width, height);
}
