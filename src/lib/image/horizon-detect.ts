/**
 * Horizon line detection using Hough Transform.
 *
 * Detects dominant straight lines in an image and returns candidates
 * for auto-straightening. Supports both horizontal and vertical line detection.
 *
 * Algorithm:
 *   1. Grayscale conversion (luminance-weighted)
 *   2. Gaussian blur (3×3) to reduce noise
 *   3. Sobel edge detection (gradient magnitude)
 *   4. Edge thresholding (keep strong edges)
 *   5. Hough Transform (accumulate votes in θ-ρ parameter space)
 *   6. Peak detection with non-maximum suppression
 *   7. Convert peaks to line candidates with angle + confidence
 */

/** A detected line candidate for horizon/vertical straightening. */
export interface HorizonCandidate {
	/** Angle deviation from reference in degrees. Positive = clockwise rotation needed to straighten. */
	angle: number;
	/** Line endpoints in normalized (0–1) coords. */
	line: { x1: number; y1: number; x2: number; y2: number };
	/** Confidence score (0–1) based on Hough vote count. */
	confidence: number;
	/** Whether this is a horizontal or vertical reference line. */
	type: 'horizontal' | 'vertical';
}

export interface DetectionOptions {
	/** Max dimension to downsample to (default: 400). Larger = slower but more precise. */
	maxDimension?: number;
	/** Edge magnitude threshold as fraction of max (default: 0.1). */
	edgeThreshold?: number;
	/** Max number of candidates to return (default: 5). */
	maxCandidates?: number;
	/** Angle range in degrees to search around horizontal/vertical (default: 20). */
	angleRange?: number;
}

const DEFAULT_OPTIONS: Required<DetectionOptions> = {
	maxDimension: 400,
	edgeThreshold: 0.1,
	maxCandidates: 5,
	angleRange: 20,
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
 * Sobel edge detection. Returns gradient magnitude.
 */
function sobelEdgeDetect(
	gray: Float32Array,
	width: number,
	height: number,
): { magnitude: Float32Array; maxMag: number } {
	const magnitude = new Float32Array(width * height);
	let maxMag = 0;

	for (let y = 1; y < height - 1; y++) {
		for (let x = 1; x < width - 1; x++) {
			const idx = y * width + x;

			// Compute Gx (horizontal gradient)
			const gx =
				-gray[(y - 1) * width + (x - 1)] +
				gray[(y - 1) * width + (x + 1)] +
				-2 * gray[y * width + (x - 1)] +
				2 * gray[y * width + (x + 1)] +
				-gray[(y + 1) * width + (x - 1)] +
				gray[(y + 1) * width + (x + 1)];

			// Compute Gy (vertical gradient)
			const gy =
				-gray[(y - 1) * width + (x - 1)] +
				-2 * gray[(y - 1) * width + x] +
				-gray[(y - 1) * width + (x + 1)] +
				gray[(y + 1) * width + (x - 1)] +
				2 * gray[(y + 1) * width + x] +
				gray[(y + 1) * width + (x + 1)];

			const mag = Math.sqrt(gx * gx + gy * gy);
			magnitude[idx] = mag;
			if (mag > maxMag) maxMag = mag;
		}
	}

	return { magnitude, maxMag };
}

// ─── Hough Transform ──────────────────────────────────────────────────────────

interface HoughResult {
	accumulator: Float32Array;  // Changed to float for weighted votes
	thetas: Float32Array;  // Actual theta values in radians
	numTheta: number;
	numRho: number;
	rhoMax: number;
	width: number;
	height: number;
}

/**
 * Hough Transform for line detection with position weighting.
 *
 * Line parameterization: ρ = x·cos(θ) + y·sin(θ)
 * where θ is the angle of the line's normal vector from the x-axis.
 *
 * For a horizontal line (normal points up), θ = 90° (π/2)
 * For a vertical line (normal points right), θ = 0°
 *
 * Position weighting: pixels in the middle third (vertically) of the image
 * get higher weight, as horizons typically appear there.
 */
function houghTransform(
	magnitude: Float32Array,
	width: number,
	height: number,
	threshold: number,
	angleRange: number,
): HoughResult {
	// θ resolution: 0.5° steps for better precision
	const thetaStep = 0.5 * Math.PI / 180;
	
	// We want to detect lines that are nearly horizontal or nearly vertical.
	// Horizontal lines: θ near 90° (normal points up/down)
	// Vertical lines: θ near 0° or 180° (normal points left/right)
	
	const thetas: number[] = [];
	
	// Horizontal range: 90° - range to 90° + range (0.5° steps)
	for (let deg = 90 - angleRange; deg <= 90 + angleRange; deg += 0.5) {
		thetas.push(deg * Math.PI / 180);
	}
	
	// Vertical range: -range to +range (0.5° steps)
	for (let deg = -angleRange; deg <= angleRange; deg += 0.5) {
		const theta = deg * Math.PI / 180;
		// Avoid duplicates
		if (!thetas.some(t => Math.abs(t - theta) < 0.001)) {
			thetas.push(theta);
		}
	}
	
	const numTheta = thetas.length;
	const thetaArray = new Float32Array(thetas);
	
	// ρ can range from -diagonal to +diagonal
	const rhoMax = Math.sqrt(width * width + height * height);
	const rhoStep = 1;
	const numRho = Math.ceil(2 * rhoMax / rhoStep) + 1;

	// Use Float32Array for weighted accumulator
	const accumulator = new Float32Array(numTheta * numRho);

	// Precompute sin/cos
	const cosTable = new Float32Array(numTheta);
	const sinTable = new Float32Array(numTheta);
	for (let ti = 0; ti < numTheta; ti++) {
		cosTable[ti] = Math.cos(thetaArray[ti]);
		sinTable[ti] = Math.sin(thetaArray[ti]);
	}

	// Vote for each edge pixel with position-based weighting
	for (let y = 0; y < height; y++) {
		// Weight based on vertical position:
		// - Middle third of image gets weight 1.0 (horizon zone)
		// - Top/bottom get reduced weight
		const yNorm = y / height;  // 0 to 1
		let posWeight: number;
		if (yNorm >= 0.25 && yNorm <= 0.75) {
			// Middle half - full weight
			posWeight = 1.0;
		} else if (yNorm < 0.25) {
			// Top quarter - reduced (sky, usually not horizon)
			posWeight = 0.5 + 2 * yNorm;  // 0.5 at top, 1.0 at 0.25
		} else {
			// Bottom quarter - reduced (foreground)
			posWeight = 0.5 + 2 * (1 - yNorm);  // 1.0 at 0.75, 0.5 at bottom
		}

		for (let x = 0; x < width; x++) {
			const idx = y * width + x;
			if (magnitude[idx] < threshold) continue;

			// Weight by edge magnitude (stronger edges = more confident)
			const magWeight = magnitude[idx] / threshold;  // >= 1.0
			const weight = posWeight * Math.min(magWeight, 3.0);  // Cap at 3x

			// Vote for all theta values
			for (let ti = 0; ti < numTheta; ti++) {
				const rho = x * cosTable[ti] + y * sinTable[ti];
				// Map rho from [-rhoMax, +rhoMax] to [0, numRho-1]
				const ri = Math.round((rho + rhoMax) / rhoStep);

				if (ri >= 0 && ri < numRho) {
					accumulator[ti * numRho + ri] += weight;
				}
			}
		}
	}

	return { accumulator, thetas: thetaArray, numTheta, numRho, rhoMax, width, height };
}

interface Peak {
	theta: number;      // Radians
	thetaDeg: number;   // Degrees (for debugging)
	rho: number;        // Distance from origin
	votes: number;
	type: 'horizontal' | 'vertical';
	/** Score combining votes with position preference (for sorting). */
	score: number;
}

/**
 * Find peaks in the Hough accumulator with non-maximum suppression.
 * Applies additional scoring to prefer lines passing through the middle of the image.
 */
function findPeaks(
	hough: HoughResult,
	maxPeaks: number,
): Peak[] {
	const { accumulator, thetas, numTheta, numRho, rhoMax, width, height } = hough;
	const peaks: Peak[] = [];

	// Find global max for relative thresholding
	let globalMax = 0;
	for (let i = 0; i < accumulator.length; i++) {
		if (accumulator[i] > globalMax) globalMax = accumulator[i];
	}

	if (globalMax === 0) return [];

	// Minimum votes to consider (10% of global max)
	const minVotes = globalMax * 0.10;

	// Suppression window size (with 0.5° steps, need larger theta window)
	const thetaWindow = 10;  // ±10 bins = ±5°
	const rhoWindow = 20;    // ±20 pixels

	const suppressed = new Set<number>();

	// Find peaks iteratively
	while (peaks.length < maxPeaks * 3) {  // Get extra candidates
		let bestIdx = -1;
		let bestVotes = minVotes;

		for (let ti = 0; ti < numTheta; ti++) {
			for (let ri = 0; ri < numRho; ri++) {
				const idx = ti * numRho + ri;
				if (suppressed.has(idx)) continue;
				if (accumulator[idx] > bestVotes) {
					bestVotes = accumulator[idx];
					bestIdx = idx;
				}
			}
		}

		if (bestIdx === -1) break;

		const ti = Math.floor(bestIdx / numRho);
		const ri = bestIdx % numRho;
		const theta = thetas[ti];
		const thetaDeg = theta * 180 / Math.PI;
		const rho = ri - rhoMax;  // Convert back from index to actual rho

		// Determine if this is horizontal or vertical based on theta
		// θ near 90° → horizontal line
		// θ near 0° or 180° → vertical line
		const normalizedDeg = ((thetaDeg % 180) + 180) % 180;  // Normalize to [0, 180)
		const type: 'horizontal' | 'vertical' = 
			(normalizedDeg > 45 && normalizedDeg < 135) ? 'horizontal' : 'vertical';

		// Calculate where this line crosses the center of the image (x = width/2)
		// and score based on how close that y-intercept is to the middle
		const cosT = Math.cos(theta);
		const sinT = Math.sin(theta);
		
		let positionScore = 1.0;
		if (type === 'horizontal' && Math.abs(sinT) > 0.1) {
			// For horizontal lines, find y at x = width/2
			const yAtCenter = (rho - (width / 2) * cosT) / sinT;
			const yNorm = yAtCenter / height;  // 0 to 1
			// Score peaks if y is in the middle 60% of the image
			if (yNorm >= 0.2 && yNorm <= 0.8) {
				// Boost lines in the "horizon zone"
				const distFromMiddle = Math.abs(yNorm - 0.5);
				positionScore = 1.5 - distFromMiddle;  // 1.5 at center, 1.2 at edges of zone
			} else {
				// Penalize lines near very top or bottom
				positionScore = 0.5;
			}
		}

		// Also boost lines that are closer to perfectly horizontal/vertical
		// (deviation from 90° for horizontal, deviation from 0° for vertical)
		let angleScore = 1.0;
		if (type === 'horizontal') {
			const devFrom90 = Math.abs(normalizedDeg - 90);
			angleScore = 1.0 + (20 - Math.min(devFrom90, 20)) / 40;  // 1.0 to 1.5
		} else {
			const devFrom0 = Math.min(normalizedDeg, 180 - normalizedDeg);
			angleScore = 1.0 + (20 - Math.min(devFrom0, 20)) / 40;
		}

		const score = bestVotes * positionScore * angleScore;

		peaks.push({ theta, thetaDeg, rho, votes: bestVotes, type, score });

		// Suppress neighborhood
		for (let dti = -thetaWindow; dti <= thetaWindow; dti++) {
			for (let dri = -rhoWindow; dri <= rhoWindow; dri++) {
				const nti = ti + dti;
				const nri = ri + dri;
				if (nti >= 0 && nti < numTheta && nri >= 0 && nri < numRho) {
					suppressed.add(nti * numRho + nri);
				}
			}
		}
	}

	// Sort by score (not just votes) and return top candidates from each type
	const horizontal = peaks.filter(p => p.type === 'horizontal')
		.sort((a, b) => b.score - a.score)
		.slice(0, maxPeaks);
	const vertical = peaks.filter(p => p.type === 'vertical')
		.sort((a, b) => b.score - a.score)
		.sort((a, b) => b.votes - a.votes)
		.slice(0, maxPeaks);

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
): { x1: number; y1: number; x2: number; y2: number } | null {
	const cosT = Math.cos(theta);
	const sinT = Math.sin(theta);

	// Line equation: x·cos(θ) + y·sin(θ) = ρ
	// Find intersections with image boundaries
	const points: Array<{ x: number; y: number }> = [];

	// Left edge (x = 0): y = ρ / sin(θ)
	if (Math.abs(sinT) > 1e-6) {
		const y = rho / sinT;
		if (y >= -1 && y <= height + 1) {
			points.push({ x: 0, y: Math.max(0, Math.min(height, y)) });
		}
	}

	// Right edge (x = width): y = (ρ - width·cos(θ)) / sin(θ)
	if (Math.abs(sinT) > 1e-6) {
		const y = (rho - width * cosT) / sinT;
		if (y >= -1 && y <= height + 1) {
			points.push({ x: width, y: Math.max(0, Math.min(height, y)) });
		}
	}

	// Top edge (y = 0): x = ρ / cos(θ)
	if (Math.abs(cosT) > 1e-6) {
		const x = rho / cosT;
		if (x >= -1 && x <= width + 1) {
			points.push({ x: Math.max(0, Math.min(width, x)), y: 0 });
		}
	}

	// Bottom edge (y = height): x = (ρ - height·sin(θ)) / cos(θ)
	if (Math.abs(cosT) > 1e-6) {
		const x = (rho - height * sinT) / cosT;
		if (x >= -1 && x <= width + 1) {
			points.push({ x: Math.max(0, Math.min(width, x)), y: height });
		}
	}

	if (points.length < 2) {
		return null;
	}

	// Find the two points that are furthest apart
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
 * Returns the angle in degrees to rotate the image so the line becomes
 * perfectly horizontal (for horizontal type) or vertical (for vertical type).
 * Positive = clockwise rotation.
 */
function calculateStraightenAngle(
	line: { x1: number; y1: number; x2: number; y2: number },
	type: 'horizontal' | 'vertical',
): number {
	const dx = line.x2 - line.x1;
	const dy = line.y2 - line.y1;
	
	// Angle of the line from horizontal (in degrees)
	// atan2(dy, dx) gives angle in radians from -π to +π
	const lineAngleRad = Math.atan2(dy, dx);
	const lineAngleDeg = lineAngleRad * (180 / Math.PI);

	if (type === 'horizontal') {
		// The line should be at 0° (horizontal)
		// If line is at +5°, we need to rotate -5° to straighten
		// Normalize angle to [-90, +90] range (a line at 170° is same as -10°)
		let deviation = lineAngleDeg;
		while (deviation > 90) deviation -= 180;
		while (deviation < -90) deviation += 180;
		return -deviation;
	} else {
		// The line should be at 90° (vertical)
		// If line is at 85°, we need to rotate +5° to make it 90°
		// Normalize to find deviation from vertical (±90°)
		let deviation = lineAngleDeg;
		// Bring into [-90, 90] range first
		while (deviation > 90) deviation -= 180;
		while (deviation < -90) deviation += 180;
		// Now deviation is angle from horizontal; deviation from vertical is (90 - |deviation|) with sign
		if (deviation >= 0) {
			return -(deviation - 90);  // e.g., 85° → rotate +5°
		} else {
			return -(-90 - deviation);  // e.g., -85° → rotate -5°
		}
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

	console.log('[horizon] Starting detection on', srcWidth, 'x', srcHeight, 'image');

	// 1. Downsample if needed
	let width = srcWidth;
	let height = srcHeight;
	let pixels = data;

	if (Math.max(srcWidth, srcHeight) > opts.maxDimension) {
		const scale = opts.maxDimension / Math.max(srcWidth, srcHeight);
		width = Math.round(srcWidth * scale);
		height = Math.round(srcHeight * scale);

		console.log('[horizon] Downsampling to', width, 'x', height);

		const oc = new OffscreenCanvas(width, height);
		const ctx = oc.getContext('2d');
		if (!ctx) {
			console.error('[horizon] Failed to create OffscreenCanvas context');
			return [];
		}

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
	const { magnitude, maxMag } = sobelEdgeDetect(blurred, width, height);
	console.log('[horizon] Edge detection maxMag:', maxMag);

	// 5. Edge thresholding
	const threshold = maxMag * opts.edgeThreshold;

	// Count edge pixels for debugging
	let edgeCount = 0;
	for (let i = 0; i < magnitude.length; i++) {
		if (magnitude[i] >= threshold) edgeCount++;
	}
	console.log('[horizon] Edge pixels above threshold:', edgeCount);

	// 6. Hough Transform
	const hough = houghTransform(magnitude, width, height, threshold, opts.angleRange);
	console.log('[horizon] Hough accumulator size:', hough.numTheta, 'x', hough.numRho);

	// 7. Find peaks
	const peaks = findPeaks(hough, opts.maxCandidates);
	console.log('[horizon] Found', peaks.length, 'peaks');

	if (peaks.length === 0) {
		return [];
	}

	// 8. Convert peaks to candidates
	const maxScore = Math.max(...peaks.map(p => p.score));
	const candidates: HorizonCandidate[] = [];
	
	for (const peak of peaks) {
		const line = peakToLine(peak.theta, peak.rho, width, height);
		if (!line) {
			console.log('[horizon] Skipping peak with invalid line:', peak);
			continue;
		}

		const angle = calculateStraightenAngle(line, peak.type);
		
		// Skip if angle is too extreme (likely noise)
		if (Math.abs(angle) > opts.angleRange) {
			console.log('[horizon] Skipping peak with extreme angle:', angle, peak);
			continue;
		}

		console.log('[horizon] Candidate:', {
			type: peak.type,
			thetaDeg: peak.thetaDeg.toFixed(1),
			rho: peak.rho.toFixed(1),
			votes: peak.votes.toFixed(0),
			score: peak.score.toFixed(0),
			angle: angle.toFixed(2),
			line: {
				x1: line.x1.toFixed(3),
				y1: line.y1.toFixed(3),
				x2: line.x2.toFixed(3),
				y2: line.y2.toFixed(3),
			},
		});

		candidates.push({
			angle,
			line,
			confidence: peak.score / maxScore,
			type: peak.type,
		});
	}

	// Sort by confidence (highest first)
	candidates.sort((a, b) => b.confidence - a.confidence);

	// Filter out near-duplicate angles (within 0.5°)
	const filtered: HorizonCandidate[] = [];
	for (const c of candidates) {
		const isDuplicate = filtered.some(
			f => f.type === c.type && Math.abs(f.angle - c.angle) < 0.5,
		);
		if (!isDuplicate) {
			filtered.push(c);
		}
	}

	console.log('[horizon] Returning', filtered.length, 'candidates after filtering');
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
