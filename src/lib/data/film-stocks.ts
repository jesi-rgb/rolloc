import type { FilmType } from '$lib/types';

export interface FilmStock {
	brand: string;
	model: string;
	iso:   number;
	type:  FilmType;
}

/** Full display name for a film stock: "Brand Model". */
export function filmStockLabel(stock: FilmStock): string {
	return `${stock.brand} ${stock.model}`;
}

/**
 * Curated list of popular film stocks, including discontinued and limited-run emulsions
 * that still circulate as expired or small-batch rolls.
 * Sorted by brand alphabetically, then by ISO ascending within each brand.
 *
 * `type` is the inversion mode, not the lab process: ECN-2 cine stocks are listed as C41
 * (orange-masked negative) and Kodachrome (K-14) as E6 (positive slide).
 */
export const FILM_STOCKS: FilmStock[] = [
	// ── Adox ──────────────────────────────────────────────────────────────────
	{ brand: 'Adox',       model: 'CMS 20 II',       iso:   20, type: 'BW'  },
	{ brand: 'Adox',       model: 'Scala 50',         iso:   50, type: 'BW'  },
	{ brand: 'Adox',       model: 'HR-50',            iso:   50, type: 'BW'  },
	{ brand: 'Adox',       model: 'CHS 100 II',       iso:  100, type: 'BW'  },
	{ brand: 'Adox',       model: 'Silvermax 100',    iso:  100, type: 'BW'  },
	{ brand: 'Adox',       model: 'Color Mission 200',iso:  200, type: 'C41' },

	// ── Agfa ──────────────────────────────────────────────────────────────────
	{ brand: 'Agfa',       model: 'Copex Rapid 50',   iso:   50, type: 'BW'  },
	{ brand: 'Agfa',       model: 'APX 100',          iso:  100, type: 'BW'  },
	{ brand: 'Agfa',       model: 'CT Precisa 100',   iso:  100, type: 'E6'  },
	{ brand: 'Agfa',       model: 'Vista Plus 200',   iso:  200, type: 'C41' },
	{ brand: 'Agfa',       model: 'APX 400',          iso:  400, type: 'BW'  },
	{ brand: 'Agfa',       model: 'Vista Plus 400',   iso:  400, type: 'C41' },

	// ── Bergger ───────────────────────────────────────────────────────────────
	{ brand: 'Bergger',    model: 'Pancro 400',       iso:  400, type: 'BW'  },

	// ── CineStill ─────────────────────────────────────────────────────────────
	{ brand: 'CineStill',  model: '50D',              iso:   50, type: 'C41' },
	{ brand: 'CineStill',  model: 'BwXX',             iso:  250, type: 'BW'  },
	{ brand: 'CineStill',  model: '400D',             iso:  400, type: 'C41' },
	{ brand: 'CineStill',  model: '800T',             iso:  800, type: 'C41' },

	// ── Dubblefilm ────────────────────────────────────────────────────────────
	{ brand: 'Dubblefilm', model: 'Show 200',         iso:  200, type: 'C41' },
	{ brand: 'Dubblefilm', model: 'Chrome 400',       iso:  400, type: 'C41' },
	{ brand: 'Dubblefilm', model: 'Stereo 400',       iso:  400, type: 'C41' },

	// ── Ferrania ──────────────────────────────────────────────────────────────
	{ brand: 'Ferrania',   model: 'Orto 50',          iso:   50, type: 'BW'  },
	{ brand: 'Ferrania',   model: 'P30 Alpha',        iso:   80, type: 'BW'  },

	// ── Fomapan ───────────────────────────────────────────────────────────────
	{ brand: 'Fomapan',    model: 'Classic 100',      iso:  100, type: 'BW'  },
	{ brand: 'Fomapan',    model: 'R 100',            iso:  100, type: 'BW'  },
	{ brand: 'Fomapan',    model: 'Creative 200',     iso:  200, type: 'BW'  },
	{ brand: 'Fomapan',    model: 'Retropan 320',     iso:  320, type: 'BW'  },
	{ brand: 'Fomapan',    model: 'Action 400',       iso:  400, type: 'BW'  },

	// ── Fujifilm (color negative) ─────────────────────────────────────────────
	{ brand: 'Fujifilm',   model: 'Fujicolor 100',    iso:  100, type: 'C41' },
	{ brand: 'Fujifilm',   model: 'Industrial 100',   iso:  100, type: 'C41' },
	{ brand: 'Fujifilm',   model: 'Reala 100',        iso:  100, type: 'C41' },
	{ brand: 'Fujifilm',   model: 'Pro 160NS',        iso:  160, type: 'C41' },
	{ brand: 'Fujifilm',   model: '200',              iso:  200, type: 'C41' },
	{ brand: 'Fujifilm',   model: 'C200',             iso:  200, type: 'C41' },
	{ brand: 'Fujifilm',   model: 'Superia 200',      iso:  200, type: 'C41' },
	{ brand: 'Fujifilm',   model: '400',              iso:  400, type: 'C41' },
	{ brand: 'Fujifilm',   model: 'Superia X-TRA 400',iso:  400, type: 'C41' },
	{ brand: 'Fujifilm',   model: 'Superia 400',      iso:  400, type: 'C41' },
	{ brand: 'Fujifilm',   model: 'Pro 400H',         iso:  400, type: 'C41' },
	{ brand: 'Fujifilm',   model: 'Superia 800',      iso:  800, type: 'C41' },
	{ brand: 'Fujifilm',   model: 'Press 800',        iso:  800, type: 'C41' },
	{ brand: 'Fujifilm',   model: 'Natura 1600',      iso: 1600, type: 'C41' },

	// ── Fujifilm (slide / E6) ─────────────────────────────────────────────────
	{ brand: 'Fujifilm',   model: 'Velvia 50',        iso:   50, type: 'E6'  },
	{ brand: 'Fujifilm',   model: 'Provia 100F',      iso:  100, type: 'E6'  },
	{ brand: 'Fujifilm',   model: 'Velvia 100',       iso:  100, type: 'E6'  },
	{ brand: 'Fujifilm',   model: 'Astia 100F',       iso:  100, type: 'E6'  },
	{ brand: 'Fujifilm',   model: 'Sensia 100',       iso:  100, type: 'E6'  },
	{ brand: 'Fujifilm',   model: 'Provia 400X',      iso:  400, type: 'E6'  },

	// ── Fujifilm (black & white) ──────────────────────────────────────────────
	{ brand: 'Fujifilm',   model: 'Acros 100 II',     iso:  100, type: 'BW'  },
	{ brand: 'Fujifilm',   model: 'Neopan 400',       iso:  400, type: 'BW'  },

	// ── Harman ────────────────────────────────────────────────────────────────
	{ brand: 'Harman',     model: 'Red 125',          iso:  125, type: 'C41' },
	{ brand: 'Harman',     model: 'Switch Azure 125', iso:  125, type: 'C41' },
	{ brand: 'Harman',     model: 'Phoenix 200',      iso:  200, type: 'C41' },
	{ brand: 'Harman',     model: 'Phoenix II 200',   iso:  200, type: 'C41' },

	// ── Ilford ────────────────────────────────────────────────────────────────
	{ brand: 'Ilford',     model: 'Pan F Plus 50',    iso:   50, type: 'BW'  },
	{ brand: 'Ilford',     model: 'Ortho Plus 80',    iso:   80, type: 'BW'  },
	{ brand: 'Ilford',     model: 'Delta 100',        iso:  100, type: 'BW'  },
	{ brand: 'Ilford',     model: 'Pan 100',          iso:  100, type: 'BW'  },
	{ brand: 'Ilford',     model: 'FP4 Plus 125',     iso:  125, type: 'BW'  },
	{ brand: 'Ilford',     model: 'SFX 200',          iso:  200, type: 'BW'  },
	{ brand: 'Ilford',     model: 'HP5 Plus 400',     iso:  400, type: 'BW'  },
	{ brand: 'Ilford',     model: 'Delta 400',        iso:  400, type: 'BW'  },
	{ brand: 'Ilford',     model: 'Pan 400',          iso:  400, type: 'BW'  },
	{ brand: 'Ilford',     model: 'XP2 Super 400',    iso:  400, type: 'C41' },
	{ brand: 'Ilford',     model: 'Delta 3200',       iso: 3200, type: 'BW'  },

	// ── JCH ───────────────────────────────────────────────────────────────────
	{ brand: 'JCH',        model: 'StreetPan 400',    iso:  400, type: 'BW'  },

	// ── Kentmere ──────────────────────────────────────────────────────────────
	{ brand: 'Kentmere',   model: 'Pan 100',          iso:  100, type: 'BW'  },
	{ brand: 'Kentmere',   model: 'Pan 200',          iso:  200, type: 'BW'  },
	{ brand: 'Kentmere',   model: 'Pan 400',          iso:  400, type: 'BW'  },

	// ── Kodak (color negative) ────────────────────────────────────────────────
	{ brand: 'Kodak',      model: 'Ektar 100',        iso:  100, type: 'C41' },
	{ brand: 'Kodak',      model: 'Kodacolor 100',    iso:  100, type: 'C41' },
	{ brand: 'Kodak',      model: 'Pro Image 100',    iso:  100, type: 'C41' },
	{ brand: 'Kodak',      model: 'Portra 160',       iso:  160, type: 'C41' },
	{ brand: 'Kodak',      model: 'Colorplus 200',    iso:  200, type: 'C41' },
	{ brand: 'Kodak',      model: 'Gold 200',         iso:  200, type: 'C41' },
	{ brand: 'Kodak',      model: 'Kodacolor 200',    iso:  200, type: 'C41' },
	{ brand: 'Kodak',      model: 'UltraMax 400',     iso:  400, type: 'C41' },
	{ brand: 'Kodak',      model: 'Portra 400',       iso:  400, type: 'C41' },
	{ brand: 'Kodak',      model: 'BW400CN',          iso:  400, type: 'C41' },
	{ brand: 'Kodak',      model: 'Portra 800',       iso:  800, type: 'C41' },

	// ── Kodak (cine / ECN-2) ──────────────────────────────────────────────────
	{ brand: 'Kodak',      model: 'Vision3 50D',      iso:   50, type: 'C41' },
	{ brand: 'Kodak',      model: 'Vision3 200T',     iso:  200, type: 'C41' },
	{ brand: 'Kodak',      model: 'Vision3 250D',     iso:  250, type: 'C41' },
	{ brand: 'Kodak',      model: 'Vision3 500T',     iso:  500, type: 'C41' },

	// ── Kodak (slide / E6, K-14) ──────────────────────────────────────────────
	{ brand: 'Kodak',      model: 'Kodachrome 25',    iso:   25, type: 'E6'  },
	{ brand: 'Kodak',      model: 'Kodachrome 64',    iso:   64, type: 'E6'  },
	{ brand: 'Kodak',      model: 'Ektachrome E100',  iso:  100, type: 'E6'  },
	{ brand: 'Kodak',      model: 'Ektachrome E100VS',iso:  100, type: 'E6'  },
	{ brand: 'Kodak',      model: 'Elite Chrome 100', iso:  100, type: 'E6'  },

	// ── Kodak (black & white) ─────────────────────────────────────────────────
	{ brand: 'Kodak',      model: 'T-Max 100',        iso:  100, type: 'BW'  },
	{ brand: 'Kodak',      model: 'Plus-X 125',       iso:  125, type: 'BW'  },
	{ brand: 'Kodak',      model: 'Double-X 250',     iso:  250, type: 'BW'  },
	{ brand: 'Kodak',      model: 'T-Max 400',        iso:  400, type: 'BW'  },
	{ brand: 'Kodak',      model: 'Tri-X 400',        iso:  400, type: 'BW'  },
	{ brand: 'Kodak',      model: 'T-Max P3200',      iso: 3200, type: 'BW'  },

	// ── Konica ────────────────────────────────────────────────────────────────
	{ brand: 'Konica',     model: 'Centuria 200',     iso:  200, type: 'C41' },
	{ brand: 'Konica',     model: 'Centuria 400',     iso:  400, type: 'C41' },

	// ── KONO! ─────────────────────────────────────────────────────────────────
	{ brand: 'KONO!',      model: 'Color 200',        iso:  200, type: 'C41' },

	// ── Kosmo Foto ────────────────────────────────────────────────────────────
	{ brand: 'Kosmo Foto', model: 'Mono 100',         iso:  100, type: 'BW'  },
	{ brand: 'Kosmo Foto', model: 'Direktor 250',     iso:  250, type: 'BW'  },
	{ brand: 'Kosmo Foto', model: 'Agent Shadow 400', iso:  400, type: 'BW'  },

	// ── Leica ─────────────────────────────────────────────────────────────────
	{ brand: 'Leica',      model: 'Monopan 50',       iso:   50, type: 'BW'  },

	// ── Lomography ────────────────────────────────────────────────────────────
	{ brand: 'Lomography', model: 'Fantôme Kino 8',      iso:    8, type: 'BW'  },
	{ brand: 'Lomography', model: 'Babylon Kino 13',     iso:   13, type: 'BW'  },
	{ brand: 'Lomography', model: 'Color Negative 100',  iso:  100, type: 'C41' },
	{ brand: 'Lomography', model: 'Earl Grey 100',        iso:  100, type: 'BW'  },
	{ brand: 'Lomography', model: 'Potsdam Kino 100',     iso:  100, type: 'BW'  },
	{ brand: 'Lomography', model: 'Redscale XR 50-200',   iso:  100, type: 'C41' },
	{ brand: 'Lomography', model: 'Color Negative 400',  iso:  400, type: 'C41' },
	{ brand: 'Lomography', model: 'LomoChrome Color \'92', iso: 400, type: 'C41' },
	{ brand: 'Lomography', model: 'LomoChrome Purple',    iso:  400, type: 'C41' },
	{ brand: 'Lomography', model: 'LomoChrome Turquoise', iso:  400, type: 'C41' },
	{ brand: 'Lomography', model: 'Metropolis 400',       iso:  400, type: 'C41' },
	{ brand: 'Lomography', model: 'Lady Grey 400',        iso:  400, type: 'BW'  },
	{ brand: 'Lomography', model: 'Berlin Kino 400',      iso:  400, type: 'BW'  },
	{ brand: 'Lomography', model: 'Color Negative 800',  iso:  800, type: 'C41' },

	// ── Lucky ─────────────────────────────────────────────────────────────────
	{ brand: 'Lucky',      model: 'SHD 100',          iso:  100, type: 'BW'  },
	{ brand: 'Lucky',      model: 'Yingzhe 100',      iso:  100, type: 'BW'  },
	{ brand: 'Lucky',      model: 'C200',             iso:  200, type: 'C41' },
	{ brand: 'Lucky',      model: 'C400',             iso:  400, type: 'C41' },
	{ brand: 'Lucky',      model: 'SHD 400',          iso:  400, type: 'BW'  },
	{ brand: 'Lucky',      model: 'Yingzhe 400',      iso:  400, type: 'BW'  },

	// ── Mira ──────────────────────────────────────────────────────────────────
	{ brand: 'Mira',       model: 'Color 400',        iso:  400, type: 'C41' },

	// ── Optik Oldschool ───────────────────────────────────────────────────────
	{ brand: 'Optik Oldschool', model: 'OptiColour 200', iso: 200, type: 'C41' },

	// ── ORWO ──────────────────────────────────────────────────────────────────
	{ brand: 'ORWO',       model: 'UN54',             iso:  100, type: 'BW'  },
	{ brand: 'ORWO',       model: 'Wolfen NC200',     iso:  200, type: 'C41' },
	{ brand: 'ORWO',       model: 'N74 Plus',         iso:  400, type: 'BW'  },
	{ brand: 'ORWO',       model: 'Wolfen NC400',     iso:  400, type: 'C41' },
	{ brand: 'ORWO',       model: 'Wolfen NC500',     iso:  500, type: 'C41' },

	// ── Reflx Lab ─────────────────────────────────────────────────────────────
	{ brand: 'Reflx Lab',  model: 'Pro 100',          iso:  100, type: 'C41' },

	// ── Rollei ────────────────────────────────────────────────────────────────
	{ brand: 'Rollei',     model: 'Ortho 25',         iso:   25, type: 'BW'  },
	{ brand: 'Rollei',     model: 'RPX 25',           iso:   25, type: 'BW'  },
	{ brand: 'Rollei',     model: 'Retro 80S',        iso:   80, type: 'BW'  },
	{ brand: 'Rollei',     model: 'Blackbird 100',    iso:  100, type: 'BW'  },
	{ brand: 'Rollei',     model: 'RPX 100',          iso:  100, type: 'BW'  },
	{ brand: 'Rollei',     model: 'Superpan 200',     iso:  200, type: 'BW'  },
	{ brand: 'Rollei',     model: 'CR 200',           iso:  200, type: 'E6'  },
	{ brand: 'Rollei',     model: 'Digibase CN 200',  iso:  200, type: 'C41' },
	{ brand: 'Rollei',     model: 'RPX 400',          iso:  400, type: 'BW'  },
	{ brand: 'Rollei',     model: 'Retro 400S',       iso:  400, type: 'BW'  },
	{ brand: 'Rollei',     model: 'Infrared 400',     iso:  400, type: 'BW'  },

	// ── Shanghai ──────────────────────────────────────────────────────────────
	{ brand: 'Shanghai',   model: 'GP3 100',          iso:  100, type: 'BW'  },

	// ── Street Candy ──────────────────────────────────────────────────────────
	{ brand: 'Street Candy', model: 'ATM 400',        iso:  400, type: 'BW'  },

	// ── Svema ─────────────────────────────────────────────────────────────────
	{ brand: 'Svema',      model: 'Foto 100',         iso:  100, type: 'BW'  },

	// ── Washi ─────────────────────────────────────────────────────────────────
	{ brand: 'Washi',      model: 'Film A',           iso:   25, type: 'BW'  },
	{ brand: 'Washi',      model: 'Film S',           iso:  100, type: 'BW'  },
	{ brand: 'Washi',      model: 'Film W',           iso:  100, type: 'C41' },
];

/** Type label displayed in the dropdown. */
export const FILM_TYPE_LABEL: Record<string, string> = {
	C41: 'C-41',
	BW:  'B&W',
	E6:  'E-6',
};
