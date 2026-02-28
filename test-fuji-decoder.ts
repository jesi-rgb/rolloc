/**
 * Test the Fujifilm MakerNote decoder using exifr
 */
import exifr from "exifr";
import { parseFujifilmMakerNote } from "./src/lib/image/fuji-makernote";

const filePath = process.argv[2];

if (!filePath) {
	console.error("Usage: bun test-fuji-decoder.ts <path-to-image>");
	process.exit(1);
}

async function testDecoder() {
	try {
		console.log("=== Testing Fujifilm MakerNote Decoder ===\n");
		
		console.log("Extracting MakerNote with exifr...\n");
		const rawData = await exifr.parse(filePath, {
			makerNote: true,
			translateKeys: false,
			translateValues: false,
			mergeOutput: false,
		});

		console.log("Raw data structure:");
		console.log("Available segments:", Object.keys(rawData || {}));
		
		const makerNote = rawData?.makerNote;
		
		if (!makerNote) {
			console.error("No MakerNote found in image");
			console.log("\nFull raw data:", JSON.stringify(rawData, null, 2));
			process.exit(1);
		}
		
		console.log("\nMakerNote type:", typeof makerNote);
		console.log("MakerNote is array?", Array.isArray(makerNote));
		
		if (typeof makerNote === "object") {
			const keys = Object.keys(makerNote);
			console.log(`MakerNote has ${keys.length} keys`);
			console.log("First 10 keys:", keys.slice(0, 10));
		}
		
		console.log("\nMakerNote header bytes 0-7:", 
			String.fromCharCode(
				makerNote[0] || 0,
				makerNote[1] || 0,
				makerNote[2] || 0,
				makerNote[3] || 0,
				makerNote[4] || 0,
				makerNote[5] || 0,
				makerNote[6] || 0,
				makerNote[7] || 0
			)
		);
		
		console.log("\nDecoding Fujifilm settings...\n");
		const settings = parseFujifilmMakerNote(makerNote);
		
		console.log("=== DECODED FUJIFILM SETTINGS ===");
		console.log(JSON.stringify(settings, null, 2));
		
		if (Object.keys(settings).length === 0) {
			console.log("\nNo Fujifilm settings decoded.");
			console.log("First 20 MakerNote bytes:", 
				Array.from({ length: 20 }, (_, i) => makerNote[i] || 0)
			);
		}
		
	} catch (error) {
		console.error("Error:", error);
		process.exit(1);
	}
}

testDecoder();
