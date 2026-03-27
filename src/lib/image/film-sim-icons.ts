/**
 * Fujifilm film simulation icon mapping.
 *
 * Maps film simulation names to their corresponding icon character and font class.
 * Currently fficn30, fficn32, fficn33, and fficn62 fonts are available in /fonts/
 *
 * NOTE: Some film simulations (ETERNA/CINEMA, ETERNA BLEACH BYPASS)
 * require the fficn63 font file that is not yet available.
 */

interface FilmSimIcon {
	/** The character to display (will be rendered with the icon font) */
	char: string;
	/** The font family class (e.g. 'fficn30', 'fficn32') */
	font: string;
}

/**
 * Film simulation name → icon mapping.
 * Keys match the exact strings returned by parseFujifilmMakerNote in fuji-makernote.ts
 */
export const FILM_SIM_ICONS: Record<string, FilmSimIcon> = {
	// fficn30 — PROVIA/Standard, Velvia variants, Sepia, B&W
	"F0/Standard (Provia)": { char: "c", font: "fficn30" },
	"F2/Fujichrome (Velvia)": { char: "d", font: "fficn30" },
	"F4/Velvia": { char: "d", font: "fficn30" },
	"Astia": { char: "e", font: "fficn30" },
	"B&W Sepia": { char: "f", font: "fficn30" },
	"None (B&W)": { char: "b", font: "fficn30" },

	// fficn32 — Classic Chrome, Pro Neg, Monochrome filters
	"Classic Chrome": { char: "i", font: "fficn32" },
	"Pro Neg. Hi": { char: "g", font: "fficn32" },
	"Pro Neg. Std": { char: "h", font: "fficn32" },
	"B&W Yellow Filter": { char: "e", font: "fficn32" },
	"B&W Red Filter": { char: "d", font: "fficn32" },
	"B&W Green Filter": { char: "f", font: "fficn32" },

	// fficn33 — Classic Negative
	"Classic Negative": { char: "g", font: "fficn33" },

	// fficn62 — Acros and Acros filter variants
	"Acros": { char: "a", font: "fficn62" },
	"Acros Yellow Filter": { char: "d", font: "fficn62" },
	"Acros Red Filter": { char: "c", font: "fficn62" },
	"Acros Green Filter": { char: "b", font: "fficn62" },

	// The following require the fficn63 font file not yet available:
	// "Eterna": { char: "X", font: "fficn63" },
	// "Bleach Bypass": { char: "N", font: "fficn63" },
};

/**
 * Get the icon for a given film simulation name.
 * Returns null if no icon is defined for this simulation.
 */
export function getFilmSimIcon(filmMode: string): FilmSimIcon | null {
	return FILM_SIM_ICONS[filmMode] ?? null;
}
