/**
 * Test script using node-exif library to extract Fujifilm MakerNote
 */
import ExifImage from "exif";
import { promisify } from "util";

const filePath = process.argv[2];

if (!filePath) {
	console.error("Usage: bun test-node-exif.ts <path-to-image>");
	process.exit(1);
}

// Promisify the callback-based API
const getExif = promisify((path: string, callback: (error: Error | null, data?: unknown) => void) => {
	try {
		new ExifImage({ image: path }, callback);
	} catch (error) {
		callback(error as Error);
	}
});

async function testNodeExif() {
	try {
		console.log("=== Testing node-exif library ===\n");
		
		const exifData = await getExif(filePath);
		
		console.log("Full EXIF data structure:");
		console.log(JSON.stringify(exifData, null, 2));

		console.log("\n\n=== Looking for Fujifilm fields ===\n");
		
		// Search all nested objects for Fujifilm-related fields
		function findFujiFields(obj: unknown, path = ""): void {
			if (!obj || typeof obj !== "object") return;
			
			for (const [key, value] of Object.entries(obj)) {
				const currentPath = path ? `${path}.${key}` : key;
				const lowerKey = key.toLowerCase();
				
				if (
					lowerKey.includes("film") ||
					lowerKey.includes("grain") ||
					lowerKey.includes("chrome") ||
					lowerKey.includes("color") ||
					lowerKey.includes("clarity") ||
					lowerKey.includes("dynamic") ||
					lowerKey.includes("highlight") ||
					lowerKey.includes("shadow") ||
					lowerKey.includes("maker") ||
					lowerKey.includes("fuji")
				) {
					console.log(`${currentPath}:`, value);
				}
				
				if (typeof value === "object" && value !== null) {
					findFujiFields(value, currentPath);
				}
			}
		}
		
		findFujiFields(exifData);
		
	} catch (error) {
		console.error("Error:", error);
		process.exit(1);
	}
}

testNodeExif();
