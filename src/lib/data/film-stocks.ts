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
 * Curated list of popular film stocks.
 * Sorted by brand alphabetically, then by ISO ascending within each brand.
 */
export const FILM_STOCKS: FilmStock[] = [
	// ── Adox ──────────────────────────────────────────────────────────────────
	{ brand: 'Adox',       model: 'CMS 20 II',       iso:   20, type: 'BW'  },
	{ brand: 'Adox',       model: 'Silvermax 100',    iso:  100, type: 'BW'  },
	{ brand: 'Adox',       model: 'HR-50',            iso:   50, type: 'BW'  },

	// ── Agfa ──────────────────────────────────────────────────────────────────
	{ brand: 'Agfa',       model: 'APX 100',          iso:  100, type: 'BW'  },
	{ brand: 'Agfa',       model: 'APX 400',          iso:  400, type: 'BW'  },

	// ── CineStill ─────────────────────────────────────────────────────────────
	{ brand: 'CineStill',  model: '50D',              iso:   50, type: 'C41' },
	{ brand: 'CineStill',  model: '400D',             iso:  400, type: 'C41' },
	{ brand: 'CineStill',  model: '800T',             iso:  800, type: 'C41' },

	// ── Dubblefilm ────────────────────────────────────────────────────────────
	{ brand: 'Dubblefilm', model: 'Show 200',         iso:  200, type: 'C41' },
	{ brand: 'Dubblefilm', model: 'Chrome 400',       iso:  400, type: 'C41' },

	// ── Ferrania ──────────────────────────────────────────────────────────────
	{ brand: 'Ferrania',   model: 'P30 Alpha',        iso:   80, type: 'BW'  },

	// ── Fomapan ───────────────────────────────────────────────────────────────
	{ brand: 'Fomapan',    model: 'Action 400',       iso:  400, type: 'BW'  },
	{ brand: 'Fomapan',    model: 'Classic 100',      iso:  100, type: 'BW'  },
	{ brand: 'Fomapan',    model: 'Creative 200',     iso:  200, type: 'BW'  },

	// ── Fujifilm (color negative) ─────────────────────────────────────────────
	{ brand: 'Fujifilm',   model: 'C200',             iso:  200, type: 'C41' },
	{ brand: 'Fujifilm',   model: 'Fujicolor 100',    iso:  100, type: 'C41' },
	{ brand: 'Fujifilm',   model: 'Superia X-TRA 400',iso:  400, type: 'C41' },
	{ brand: 'Fujifilm',   model: 'Superia 200',      iso:  200, type: 'C41' },
	{ brand: 'Fujifilm',   model: 'Superia 400',      iso:  400, type: 'C41' },
	{ brand: 'Fujifilm',   model: 'Superia 800',      iso:  800, type: 'C41' },
	{ brand: 'Fujifilm',   model: 'Pro 400H',         iso:  400, type: 'C41' },
	{ brand: 'Fujifilm',   model: 'Reala 100',        iso:  100, type: 'C41' },

	// ── Fujifilm (slide / E6) ─────────────────────────────────────────────────
	{ brand: 'Fujifilm',   model: 'Provia 100F',      iso:  100, type: 'E6'  },
	{ brand: 'Fujifilm',   model: 'Velvia 50',        iso:   50, type: 'E6'  },
	{ brand: 'Fujifilm',   model: 'Velvia 100',       iso:  100, type: 'E6'  },
	{ brand: 'Fujifilm',   model: 'Astia 100F',       iso:  100, type: 'E6'  },

	// ── Fujifilm (black & white) ──────────────────────────────────────────────
	{ brand: 'Fujifilm',   model: 'Acros 100 II',     iso:  100, type: 'BW'  },
	{ brand: 'Fujifilm',   model: 'Neopan 400',       iso:  400, type: 'BW'  },

	// ── Ilford ────────────────────────────────────────────────────────────────
	{ brand: 'Ilford',     model: 'Pan F Plus 50',    iso:   50, type: 'BW'  },
	{ brand: 'Ilford',     model: 'FP4 Plus 125',     iso:  125, type: 'BW'  },
	{ brand: 'Ilford',     model: 'HP5 Plus 400',     iso:  400, type: 'BW'  },
	{ brand: 'Ilford',     model: 'Delta 100',        iso:  100, type: 'BW'  },
	{ brand: 'Ilford',     model: 'Delta 400',        iso:  400, type: 'BW'  },
	{ brand: 'Ilford',     model: 'Delta 3200',       iso: 3200, type: 'BW'  },
	{ brand: 'Ilford',     model: 'SFX 200',          iso:  200, type: 'BW'  },
	{ brand: 'Ilford',     model: 'Ortho Plus 80',    iso:   80, type: 'BW'  },
	{ brand: 'Ilford',     model: 'XP2 Super 400',    iso:  400, type: 'C41' },

	// ── Kentmere ──────────────────────────────────────────────────────────────
	{ brand: 'Kentmere',   model: 'Pan 100',          iso:  100, type: 'BW'  },
	{ brand: 'Kentmere',   model: 'Pan 400',          iso:  400, type: 'BW'  },

	// ── Kodak (color negative) ────────────────────────────────────────────────
	{ brand: 'Kodak',      model: 'Colorplus 200',    iso:  200, type: 'C41' },
	{ brand: 'Kodak',      model: 'Ektar 100',        iso:  100, type: 'C41' },
	{ brand: 'Kodak',      model: 'Gold 200',         iso:  200, type: 'C41' },
	{ brand: 'Kodak',      model: 'UltraMax 400',     iso:  400, type: 'C41' },
	{ brand: 'Kodak',      model: 'Portra 160',       iso:  160, type: 'C41' },
	{ brand: 'Kodak',      model: 'Portra 400',       iso:  400, type: 'C41' },
	{ brand: 'Kodak',      model: 'Portra 800',       iso:  800, type: 'C41' },

	// ── Kodak (slide / E6) ────────────────────────────────────────────────────
	{ brand: 'Kodak',      model: 'Ektachrome E100',  iso:  100, type: 'E6'  },

	// ── Kodak (black & white) ─────────────────────────────────────────────────
	{ brand: 'Kodak',      model: 'T-Max 100',        iso:  100, type: 'BW'  },
	{ brand: 'Kodak',      model: 'T-Max 400',        iso:  400, type: 'BW'  },
	{ brand: 'Kodak',      model: 'T-Max P3200',      iso: 3200, type: 'BW'  },
	{ brand: 'Kodak',      model: 'Tri-X 400',        iso:  400, type: 'BW'  },
	{ brand: 'Kodak',      model: 'Double-X 250',     iso:  250, type: 'BW'  },

	// ── Lomography ────────────────────────────────────────────────────────────
	{ brand: 'Lomography', model: 'Color Negative 100',  iso:  100, type: 'C41' },
	{ brand: 'Lomography', model: 'Color Negative 400',  iso:  400, type: 'C41' },
	{ brand: 'Lomography', model: 'Color Negative 800',  iso:  800, type: 'C41' },
	{ brand: 'Lomography', model: 'Lady Grey 400',        iso:  400, type: 'BW'  },
	{ brand: 'Lomography', model: 'Berlin Kino 400',      iso:  400, type: 'BW'  },
	{ brand: 'Lomography', model: 'Earl Grey 100',        iso:  100, type: 'BW'  },
	{ brand: 'Lomography', model: 'Metropolis 400',       iso:  400, type: 'C41' },
	{ brand: 'Lomography', model: 'Redscale XR 50-200',   iso:  100, type: 'C41' },

	// ── Lucky ─────────────────────────────────────────────────────────────────
	{ brand: 'Lucky',      model: 'C200',             iso:  200, type: 'C41' },

	// ── Phoenix ───────────────────────────────────────────────────────────────
	{ brand: 'Phoenix',    model: 'Phoenix 200',      iso:  200, type: 'C41' },
	{ brand: 'Phoenix',    model: 'Phoenix II 200',   iso:  200, type: 'C41' },

	// ── Rollei ────────────────────────────────────────────────────────────────
	{ brand: 'Rollei',     model: 'Ortho 25',         iso:   25, type: 'BW'  },
	{ brand: 'Rollei',     model: 'RPX 25',           iso:   25, type: 'BW'  },
	{ brand: 'Rollei',     model: 'RPX 100',          iso:  100, type: 'BW'  },
	{ brand: 'Rollei',     model: 'RPX 400',          iso:  400, type: 'BW'  },
	{ brand: 'Rollei',     model: 'Retro 80S',        iso:   80, type: 'BW'  },
	{ brand: 'Rollei',     model: 'Superpan 200',     iso:  200, type: 'BW'  },
	{ brand: 'Rollei',     model: 'CR 200',           iso:  200, type: 'E6'  },

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
