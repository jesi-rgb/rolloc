/**
 * Verify Fujifilm film simulation mappings
 * 
 * Usage:
 * 1. Take photos with your X-E4 using different film simulations
 * 2. Name them clearly (e.g., "provia.jpg", "velvia.jpg", "classic-chrome.jpg")
 * 3. Run: bun verify-film-sims.ts <image1.jpg> <image2.jpg> ...
 * 
 * This will extract the FilmMode tag value from each image so you can
 * build an accurate mapping.
 */
import exifr from "exifr";

const filePaths = process.argv.slice(2);

if (filePaths.length === 0) {
	console.error("Usage: bun verify-film-sims.ts <image1.jpg> <image2.jpg> ...");
	console.error("\nExample:");
	console.error("  bun verify-film-sims.ts provia.jpg velvia.jpg astia.jpg classic-chrome.jpg");
	process.exit(1);
}

function read16(data: Record<string, number>, offset: number, littleEndian = true): number {
	if (littleEndian) {
		return (data[offset + 1] << 8) | data[offset];
	} else {
		return (data[offset] << 8) | data[offset + 1];
	}
}

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

async function extractFilmMode(filePath: string): Promise<{ file: string; value: number | null }> {
	try {
		const rawData = await exifr.parse(filePath, {
			makerNote: true,
			translateKeys: false,
			translateValues: false,
			mergeOutput: false,
		});

		const makerNote = rawData?.makerNote;
		
		if (!makerNote) {
			return { file: filePath, value: null };
		}

		const header = String.fromCharCode(
			makerNote[0], makerNote[1], makerNote[2], makerNote[3],
			makerNote[4], makerNote[5], makerNote[6], makerNote[7]
		);

		if (header !== 'FUJIFILM') {
			return { file: filePath, value: null };
		}

		const ifdOffset = read32(makerNote, 8, true);
		const numEntries = read16(makerNote, ifdOffset, true);

		// Look for tag 0x1401 (FilmMode)
		for (let i = 0; i < numEntries; i++) {
			const entryOffset = ifdOffset + 2 + i * 12;
			const tag = read16(makerNote, entryOffset, true);
			
			if (tag === 0x1401) {
				const type = read16(makerNote, entryOffset + 2, true);
				const valueOffset = entryOffset + 8;

				let value: number;
				if (type === 3) {
					value = read16(makerNote, valueOffset, true);
				} else if (type === 4) {
					value = read32(makerNote, valueOffset, true);
				} else {
					return { file: filePath, value: null };
				}

				return { file: filePath, value };
			}
		}

		return { file: filePath, value: null };
	} catch (error) {
		console.error(`Error reading ${filePath}:`, error);
		return { file: filePath, value: null };
	}
}

async function verifyMappings() {
	console.log("=== Fujifilm Film Simulation Verification ===\n");
	console.log("Extracting FilmMode tag (0x1401) from images...\n");

	const results = await Promise.all(filePaths.map(extractFilmMode));

	console.log("Filename".padEnd(40) + " | FilmMode Value");
	console.log("-".repeat(40) + "-+-" + "-".repeat(20));

	results.forEach(({ file, value }) => {
		const filename = file.split('/').pop() || file;
		const displayValue = value !== null 
			? `0x${value.toString(16).toUpperCase().padStart(4, '0')} (${value})` 
			: "Not found";
		console.log(`${filename.padEnd(40)} | ${displayValue}`);
	});

	console.log("\n=== Suggested TypeScript Mapping ===\n");
	console.log("const FILM_MODES: Record<number, string> = {");
	
	results
		.filter(r => r.value !== null)
		.sort((a, b) => (a.value! - b.value!))
		.forEach(({ file, value }) => {
			const filename = file.split('/').pop()?.replace(/\.(jpg|jpeg)$/i, '') || file;
			const hex = `0x${value!.toString(16).padStart(3, '0')}`;
			// Convert filename to title case suggestion
			const suggestion = filename
				.split(/[-_]/)
				.map(w => w.charAt(0).toUpperCase() + w.slice(1))
				.join(' ');
			console.log(`\t${hex}: '${suggestion}',`);
		});
	
	console.log("};");

	console.log("\n=== Instructions ===");
	console.log("1. Take photos using each film simulation mode on your X-E4");
	console.log("2. Name them clearly (e.g., provia.jpg, velvia.jpg, classic-chrome.jpg)");
	console.log("3. Run this script on all images");
	console.log("4. Copy the generated mapping into src/lib/image/fuji-makernote.ts");
}

verifyMappings();
