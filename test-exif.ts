/**
 * Temporary script to inspect all EXIF data from a Fujifilm image.
 * Run with: bun test-exif.ts <path-to-fuji-image.jpg>
 */
import exifr from "exifr";

const filePath = process.argv[2];

if (!filePath) {
	console.error("Usage: bun test-exif.ts <path-to-image>");
	process.exit(1);
}

async function inspectExif() {
	try {
		// Parse with specific maker note parsing enabled
		const exif = await exifr.parse(filePath, {
			tiff: true,
			exif: true,
			gps: true,
			interop: true,
			ifd1: true,
			makerNote: true,
			userComment: true,
			translateKeys: false, // Keep original tag names
			translateValues: false, // Keep raw values
			reviveValues: true,
			sanitize: true,
			mergeOutput: false, // Keep segments separate
		});

		console.log("=== ALL EXIF DATA ===");
		console.log(JSON.stringify(exif, null, 2));

		console.log("\n\n=== SEARCHING FOR FUJIFILM FIELDS ===");
		const allFields = new Map<string, unknown>();
		
		// Collect all fields from all segments
		if (exif) {
			for (const [segment, data] of Object.entries(exif)) {
				if (data && typeof data === "object") {
					for (const [key, value] of Object.entries(data)) {
						allFields.set(`${segment}.${key}`, value);
					}
				}
			}
		}

		// Filter for potential Fujifilm fields
		const fujiFields = Array.from(allFields.entries())
			.filter(([key]) => {
				const lower = key.toLowerCase();
				return (
					lower.includes("fuji") ||
					lower.includes("film") ||
					lower.includes("grain") ||
					lower.includes("color") ||
					lower.includes("clarity") ||
					lower.includes("simulation") ||
					lower.includes("chrome") ||
					lower.includes("effect") ||
					lower.includes("mode") ||
					lower.includes("dynamic") ||
					lower.includes("range") ||
					lower.includes("white") ||
					lower.includes("balance") ||
					lower.includes("highlight") ||
					lower.includes("shadow") ||
					lower.includes("tone") ||
					lower.includes("sharpness") ||
					lower.includes("quality")
				);
			})
			.sort((a, b) => a[0].localeCompare(b[0]));

		if (fujiFields.length > 0) {
			console.log(JSON.stringify(Object.fromEntries(fujiFields), null, 2));
		} else {
			console.log("No Fujifilm-specific fields found");
		}

		// Also try parsing with a second call specifically for maker notes
		console.log("\n\n=== TRYING ALTERNATE PARSING ===");
		const exif2 = await exifr.parse(filePath);
		const relevantKeys = Object.keys(exif2 || {}).filter((key) => {
			const lower = key.toLowerCase();
			return (
				lower.includes("film") ||
				lower.includes("grain") ||
				lower.includes("color") ||
				lower.includes("simulation") ||
				lower.includes("chrome") ||
				lower.includes("dynamic")
			);
		});
		console.log("Found keys:", relevantKeys);
		relevantKeys.forEach((key) => {
			console.log(`${key}:`, exif2[key]);
		});
	} catch (error) {
		console.error("Error parsing EXIF:", error);
		process.exit(1);
	}
}

inspectExif();
