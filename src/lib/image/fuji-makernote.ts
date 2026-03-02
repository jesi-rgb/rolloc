/**
 * Fujifilm MakerNote tag decoder
 * 
 * Decodes Fujifilm-specific EXIF tags from the raw MakerNote byte array.
 * Tag definitions from: https://exiftool.org/TagNames/FujiFilm.html
 */

/**
 * Fujifilm MakerNote tags after the "FUJIFILM" header
 * These are hex tag IDs that appear in the MakerNote IFD
 */
const FUJI_TAGS = {
	// Image settings
	0x1000: 'Quality',
	0x1001: 'Sharpness',
	0x1002: 'WhiteBalance',
	0x1003: 'Saturation',
	0x1004: 'Contrast',
	0x1005: 'ColorTemperature',
	0x100a: 'WhiteBalanceFineTune',
	0x100b: 'NoiseReduction',
	0x100e: 'HighISONoiseReduction',
	0x1010: 'FujiFlashMode',
	0x1011: 'FlashExposureComp',
	0x1020: 'Macro',
	0x1021: 'FocusMode',
	0x1022: 'AFMode',
	0x1023: 'FocusPixel',
	0x102b: 'PrioritySettings',
	0x102d: 'FocusSettings',
	0x102e: 'AFCSettings',
	0x1030: 'SlowSync',
	0x1031: 'PictureMode',
	0x1032: 'ExposureCount',
	0x1033: 'EXRAuto',
	0x1034: 'EXRMode',
	0x1100: 'AutoBracketing',
	0x1101: 'SequenceNumber',
	0x1210: 'ColorSpace',
	0x1300: 'BlurWarning',
	0x1301: 'FocusWarning',
	0x1302: 'ExposureWarning',
	0x1400: 'DynamicRange',
	0x1401: 'FilmMode', // Film Simulation
	0x1402: 'DynamicRangeSetting',
	0x1403: 'DevelopmentDynamicRange',
	0x1404: 'MinFocalLength',
	0x1405: 'MaxFocalLength',
	0x1406: 'MaxApertureAtMinFocal',
	0x1407: 'MaxApertureAtMaxFocal',
	0x1422: 'ImageStabilization',
	0x1431: 'Rating',
	0x3820: 'FrameRate',
	0x3821: 'FrameWidth',
	0x3822: 'FrameHeight',
	0x4100: 'FacesDetected',
	0x4103: 'FacePositions',

	// New tags for X-series
	0x100f: 'Clarity',
	0x1047: 'GrainEffectRoughness',
	0x1048: 'ColorChromeEffect',
	0x1049: 'BWAdjustment',
	0x104b: 'BWMagentaGreen',
	0x104c: 'GrainEffectSize',
	0x104e: 'ColorChromeFXBlue',
};

/**
 * Film simulation mode values (tag 0x1401)
 * Maps internal tag values to user-friendly film simulation names
 * Source: https://exiftool.org/TagNames/FujiFilm.html
 * NOTE: Some film simulations (Acros, B&W) are in the Saturation tag (0x1003) instead
 */
const FILM_MODES: Record<number, string> = {
	0x000: 'F0/Standard (Provia)',
	0x100: 'F1/Studio Portrait',
	0x110: 'F1a/Studio Portrait Enhanced Saturation',
	0x120: 'F1b/Studio Portrait Smooth Skin Tone (Astia)',
	0x130: 'F1c/Studio Portrait Increased Sharpness',
	0x200: 'F2/Fujichrome (Velvia)',
	0x300: 'F3/Studio Portrait Ex',
	0x400: 'F4/Velvia',
	0x500: 'Pro Neg. Std',
	0x501: 'Pro Neg. Hi',
	0x600: 'Classic Chrome',
	0x700: 'Eterna',
	0x800: 'Classic Negative',
	0x900: 'Bleach Bypass',
	0xa00: 'Nostalgic Neg',
	0xb00: 'Reala ACE',
};

/**
 * Saturation tag values (tag 0x1003)
 * Film Simulation is split across FilmMode (0x1401) and Saturation (0x1003).
 * Acros and B&W modes are stored in the Saturation tag.
 * Source: https://exiftool.org/TagNames/FujiFilm.html
 */
const SATURATION_FILM_MODES: Record<number, string> = {
	0x300: 'None (B&W)',
	0x301: 'B&W Red Filter',
	0x302: 'B&W Yellow Filter',
	0x303: 'B&W Green Filter',
	0x310: 'B&W Sepia',
	0x500: 'Acros',
	0x501: 'Acros Red Filter',
	0x502: 'Acros Yellow Filter',
	0x503: 'Acros Green Filter',
	0x8000: 'Film Simulation', // Indicates film sim is in FilmMode tag instead
};

/**
 * Dynamic range values (tag 0x1400)
 */
const DYNAMIC_RANGE: Record<number, string> = {
	1: 'Standard',
	3: 'Wide',
};

/**
 * Dynamic range setting values (tag 0x1402)
 */
const DYNAMIC_RANGE_SETTING: Record<number, string> = {
	0x0: 'Auto',
	0x1: 'Manual',
	0x100: 'Standard (100%)',
	0x200: 'Wide1 (230%)',
	0x201: 'Wide2 (400%)',
	0x8000: 'Film Simulation',
};

/**
 * Grain effect values
 */
const GRAIN_EFFECT: Record<number, string> = {
	0: 'Off',
	32: 'Weak',
	64: 'Strong',
};

/**
 * Color Chrome effect values
 */
const COLOR_CHROME_EFFECT: Record<number, string> = {
	0: 'Off',
	32: 'Weak',
	64: 'Strong',
};

/**
 * Color Chrome FX Blue values
 */
const COLOR_CHROME_FX_BLUE: Record<number, string> = {
	0: 'Off',
	32: 'Weak',
	64: 'Strong',
};

/**
 * Clarity values (signed int32s)
 * ExifTool reference: -5000 = -5, -4000 = -4, ..., 0 = 0, ..., 5000 = 5
 */
function formatClarity(value: number): string {
	if (value === 0) return '0 (Normal)';
	// Convert from raw value to -5 to +5 range
	const clarityValue = value / 1000;
	return clarityValue > 0 ? `+${clarityValue}` : `${clarityValue}`;
}

/**
 * Extract a 16-bit value from the MakerNote byte array
 */
function read16(data: Record<string, number>, offset: number, littleEndian = true): number {
	if (littleEndian) {
		return (data[offset + 1] << 8) | data[offset];
	} else {
		return (data[offset] << 8) | data[offset + 1];
	}
}

/**
 * Extract a 32-bit value from the MakerNote byte array
 */
function read32(data: Record<string, number>, offset: number, littleEndian = true): number {
	if (littleEndian) {
		return (
			(data[offset + 3] << 24) |
			(data[offset + 2] << 16) |
			(data[offset + 1] << 8) |
			data[offset]
		);
	} else {
		return (
			(data[offset] << 24) |
			(data[offset + 1] << 16) |
			(data[offset + 2] << 8) |
			data[offset + 3]
		);
	}
}

/**
 * Decoded Fujifilm settings
 */
export interface FujifilmSettings {
	filmMode?: string;
	grainEffect?: string;
	colorChromeEffect?: string;
	colorChromeFXBlue?: string;
	clarity?: string;
	dynamicRange?: string;
	dynamicRangeSetting?: string;
	whiteBalance?: string;
	whiteBalanceAdjustment?: { warmCool: number; magentaGreen: number };
	noiseReduction?: number;
	sharpness?: number;
	imageStabilization?: string;
}

/**
 * Parse Fujifilm MakerNote from raw byte array
 * 
 * The MakerNote structure is:
 * - Bytes 0-7: "FUJIFILM"
 * - Bytes 8-11: Offset to IFD (usually 12)
 * - Bytes 12+: TIFF IFD with tag entries
 */
export function parseFujifilmMakerNote(
	makerNote: Record<string, number> | null | undefined
): FujifilmSettings {
	if (!makerNote) return {};

	const settings: FujifilmSettings = {};

	// Verify FUJIFILM header
	const header = String.fromCharCode(
		makerNote[0],
		makerNote[1],
		makerNote[2],
		makerNote[3],
		makerNote[4],
		makerNote[5],
		makerNote[6],
		makerNote[7]
	);

	if (header !== 'FUJIFILM') {
		console.warn('Invalid Fujifilm MakerNote header:', header);
		return {};
	}

	// Read IFD offset (bytes 8-11) - little endian
	const ifdOffset = read32(makerNote, 8, true);

	// Read number of IFD entries (2 bytes at IFD offset)
	const numEntries = read16(makerNote, ifdOffset, true);

	// Film simulation is split across FilmMode (0x1401) and Saturation (0x1003).
	// We need to check both tags and prioritize Saturation if it contains a film sim value.
	let filmModeValue: number | undefined;
	let saturationValue: number | undefined;

	// Each IFD entry is 12 bytes:
	// - 2 bytes: tag ID
	// - 2 bytes: type
	// - 4 bytes: count
	// - 4 bytes: value/offset
	for (let i = 0; i < numEntries; i++) {
		const entryOffset = ifdOffset + 2 + i * 12;
		const tag = read16(makerNote, entryOffset, true);
		const type = read16(makerNote, entryOffset + 2, true);
		const count = read32(makerNote, entryOffset + 4, true);
		const valueOffset = entryOffset + 8;

		// Read value based on type
		let value: number;
		if (type === 1) {
			// BYTE (1 byte unsigned)
			value = makerNote[valueOffset];
		} else if (type === 2) {
			// ASCII string - skip for now
			continue;
		} else if (type === 3) {
			// SHORT (2 bytes)
			value = read16(makerNote, valueOffset, true);
		} else if (type === 4) {
			// LONG (4 bytes)
			value = read32(makerNote, valueOffset, true);
		} else if (type === 6) {
			// SBYTE (signed 1 byte) - used for int8s values
			const unsigned = makerNote[valueOffset];
			value = unsigned > 0x7f ? unsigned - 0x100 : unsigned;
		} else if (type === 8) {
			// SSHORT (signed 2 bytes)
			const unsigned = read16(makerNote, valueOffset, true);
			value = unsigned > 0x7fff ? unsigned - 0x10000 : unsigned;
		} else if (type === 9) {
			// SLONG (signed 4 bytes)
			const unsigned = read32(makerNote, valueOffset, true);
			value = unsigned > 0x7fffffff ? unsigned - 0x100000000 : unsigned;
		} else {
			continue; // Skip other types for now
		}

		// Log all tags for debugging
		if (tag === 0x100a || tag === 0x1049 || tag === 0x104b) {
			console.log(`Tag 0x${tag.toString(16)}: type=${type}, count=${count}, value=${value}`);
		}

		// Decode known tags
		switch (tag) {
			case 0x1401: // FilmMode
				filmModeValue = value;
				break;
			case 0x1003: // Saturation (may contain film sim for Acros/B&W)
				saturationValue = value;
				break;
			case 0x100a: // WhiteBalanceFineTune (fallback for some camera models)
				// This tag can store values in different formats depending on camera model:
				// - Type 3 (SHORT), count=2: two 16-bit values inline, divide by 20
				// - Type 9 (SLONG), count=2: two 32-bit signed values at offset, divide by 100
				// Scale factor varies by camera model:
				// - Older cameras: divide by 20 (range -180 to +180 → -9 to +9)
				// - Newer cameras: divide by 100 (range -900 to +900 → -9 to +9)
				if (count === 2) {
					let red: number, blue: number;
					
					if (type === 3) {
						// Type 3 (SHORT): values are inline in the 4-byte value field
						const redRaw = read16(makerNote, valueOffset, true);
						const blueRaw = read16(makerNote, valueOffset + 2, true);
						// Convert unsigned to signed if needed
						red = redRaw > 0x7fff ? redRaw - 0x10000 : redRaw;
						blue = blueRaw > 0x7fff ? blueRaw - 0x10000 : blueRaw;
						console.log('WhiteBalanceFineTune (SHORT) raw:', { red, blue, redRaw, blueRaw });
					} else if (type === 9) {
						// Type 9 (SLONG): valueOffset field contains pointer to data
						const dataOffset = read32(makerNote, valueOffset, true);
						// Read two 32-bit signed integers from the data location
						const redUnsigned = read32(makerNote, dataOffset, true);
						const blueUnsigned = read32(makerNote, dataOffset + 4, true);
						// Convert unsigned to signed
						red = redUnsigned > 0x7fffffff ? redUnsigned - 0x100000000 : redUnsigned;
						blue = blueUnsigned > 0x7fffffff ? blueUnsigned - 0x100000000 : blueUnsigned;
						console.log('WhiteBalanceFineTune (SLONG) raw:', { red, blue, redUnsigned, blueUnsigned, dataOffset });
					} else {
						console.log(`WhiteBalanceFineTune: unsupported type ${type}`);
						break;
					}
					
					// Only set if not already set by 0x1049/0x104b (newer tags take precedence)
					if (!settings.whiteBalanceAdjustment) {
						// Auto-detect the divisor based on value magnitude
						const maxAbs = Math.max(Math.abs(red), Math.abs(blue));
						let divisor: number;
						
						if (maxAbs > 180) {
							// Values are in range -900 to +900, divide by 100
							divisor = 100;
						} else {
							// Values are in range -180 to +180, divide by 20
							divisor = 20;
						}
						
						// red = magenta/green axis, blue = warm/cool axis
						const mg = red / divisor;
						const wc = blue / divisor;
						
						console.log('WhiteBalanceFineTune calculated:', { mg, wc, divisor });
						
						// Only set if values are in valid range (-9 to +9)
						// This prevents displaying garbage data from uninitialized EXIF fields
						if (mg >= -9 && mg <= 9 && wc >= -9 && wc <= 9) {
							settings.whiteBalanceAdjustment = { 
								warmCool: wc, 
								magentaGreen: mg 
							};
							console.log('WhiteBalanceFineTune set:', settings.whiteBalanceAdjustment);
						} else {
							console.log('WhiteBalanceFineTune out of range, skipped');
						}
					}
				}
				break;
			case 0x1049: // BWAdjustment (warm/cool axis)
				// Value is int8s (-9 to +9), positive = warm, negative = cool
				console.log('BWAdjustment (0x1049) value:', value);
				if (!settings.whiteBalanceAdjustment) {
					settings.whiteBalanceAdjustment = { warmCool: 0, magentaGreen: 0 };
				}
				settings.whiteBalanceAdjustment.warmCool = value;
				break;
			case 0x104b: // BWMagentaGreen (magenta/green axis)
				// Value is int8s (-9 to +9), positive = green, negative = magenta
				console.log('BWMagentaGreen (0x104b) value:', value);
				if (!settings.whiteBalanceAdjustment) {
					settings.whiteBalanceAdjustment = { warmCool: 0, magentaGreen: 0 };
				}
				settings.whiteBalanceAdjustment.magentaGreen = value;
				break;
			case 0x1047: // GrainEffectRoughness
				settings.grainEffect = GRAIN_EFFECT[value] || `Unknown (${value})`;
				break;
			case 0x1048: // ColorChromeEffect
				settings.colorChromeEffect =
					COLOR_CHROME_EFFECT[value] || `Unknown (${value})`;
				break;
			case 0x104e: // ColorChromeFXBlue
				settings.colorChromeFXBlue =
					COLOR_CHROME_FX_BLUE[value] || `Unknown (${value})`;
				break;
			case 0x100f: // Clarity
				settings.clarity = formatClarity(value);
				break;
			case 0x1400: // DynamicRange
				settings.dynamicRange = DYNAMIC_RANGE[value] || `Unknown (${value})`;
				break;
			case 0x1402: // DynamicRangeSetting
				settings.dynamicRangeSetting =
					DYNAMIC_RANGE_SETTING[value] || `Unknown (0x${value.toString(16)})`;
				break;
			case 0x100b: // NoiseReduction
				settings.noiseReduction = value;
				break;
			case 0x1001: // Sharpness
				settings.sharpness = value;
				break;
		}
	}

	// Determine film simulation from FilmMode and Saturation tags
	// Priority: Saturation (if contains film sim) > FilmMode
	if (saturationValue !== undefined && SATURATION_FILM_MODES[saturationValue]) {
		const satFilmMode = SATURATION_FILM_MODES[saturationValue];
		// Only use Saturation if it's not the "Film Simulation" placeholder value
		if (satFilmMode !== 'Film Simulation') {
			settings.filmMode = satFilmMode;
		} else if (filmModeValue !== undefined) {
			// Saturation says to use FilmMode tag
			settings.filmMode = FILM_MODES[filmModeValue] || `Unknown (0x${filmModeValue.toString(16)})`;
		}
	} else if (filmModeValue !== undefined) {
		// No Saturation film sim, use FilmMode
		settings.filmMode = FILM_MODES[filmModeValue] || `Unknown (0x${filmModeValue.toString(16)})`;
	}

	console.log('Final FujifilmSettings:', settings);
	return settings;
}
