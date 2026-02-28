/**
 * Test script to extract Fujifilm-specific tags from MakerNote
 * Run with: bun test-fuji-tags.ts <path-to-fuji-image.jpg>
 */
import exifr from "exifr";

const filePath = process.argv[2];

if (!filePath) {
	console.error("Usage: bun test-fuji-tags.ts <path-to-image>");
	process.exit(1);
}

async function testFujiTags() {
	try {
		// Try to get raw maker note tags with translation
		console.log("=== Testing with translateValues: true ===");
		const parsed1 = await exifr.parse(filePath, {
			makerNote: true,
			translateValues: true,
			translateKeys: true,
			mergeOutput: true,
		});

		console.log("\nAll top-level keys:");
		console.log(Object.keys(parsed1).sort());

		const fujiKeys = Object.keys(parsed1).filter((k) => {
			const lower = k.toLowerCase();
			return (
				lower.includes("fuji") ||
				lower.includes("film") ||
				lower.includes("grain") ||
				lower.includes("color") ||
				lower.includes("simulation") ||
				lower.includes("chrome") ||
				lower.includes("dynamic") ||
				lower.includes("white") ||
				lower.includes("quality") ||
				lower.includes("sharp") ||
				lower.includes("highlight") ||
				lower.includes("shadow")
			);
		});

		console.log("\nPotential Fuji keys found:", fujiKeys);
		fujiKeys.forEach((key) => {
			console.log(`  ${key}:`, parsed1[key]);
		});

		// Try extracting specific known Fujifilm tag numbers
		console.log("\n\n=== Trying specific Fujifilm tag numbers ===");
		const parsed2 = await exifr.parse(filePath, {
			makerNote: true,
			translateKeys: false, // Get raw tag numbers
			translateValues: false,
			mergeOutput: false,
		});

		console.log("\nMakerNote segment type:", typeof parsed2?.makerNote);
		if (parsed2?.makerNote && typeof parsed2.makerNote === "object") {
			console.log("MakerNote keys:", Object.keys(parsed2.makerNote));
		}

		// Try to use exifr.gps, exifr.thumbnail, etc. utilities
		console.log("\n\n=== Using exifr segment extractors ===");
		const segments = await exifr.parse(filePath, {
			tiff: true,
			exif: true,
			makerNote: true,
			mergeOutput: false,
			translateKeys: true,
			translateValues: true,
		});

		console.log("\nAvailable segments:", Object.keys(segments || {}));
		if (segments?.makerNote) {
			console.log(
				"MakerNote type:",
				typeof segments.makerNote,
				Array.isArray(segments.makerNote) ? "array" : "object"
			);
			if (typeof segments.makerNote === "object" && !Array.isArray(segments.makerNote)) {
				const keys = Object.keys(segments.makerNote);
				console.log(`MakerNote has ${keys.length} keys`);
				console.log("First 20 keys:", keys.slice(0, 20));
			}
		}
	} catch (error) {
		console.error("Error:", error);
		process.exit(1);
	}
}

testFujiTags();
