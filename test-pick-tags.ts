/**
 * Test script using exifr.parse with pick option for Fujifilm tags
 * Known Fujifilm MakerNote tag IDs from https://exiftool.org/TagNames/FujiFilm.html
 */
import exifr from "exifr";

const filePath = process.argv[2];

if (!filePath) {
	console.error("Usage: bun test-pick-tags.ts <path-to-image>");
	process.exit(1);
}

// Fujifilm MakerNote tag names (from ExifTool documentation)
const FUJI_TAGS = [
	"FilmMode", // Film simulation mode
	"GrainEffect",
	"ColorChromeEffect",
	"ColorChromeFXBlue",
	"DynamicRange",
	"DynamicRangeSetting",
	"WhiteBalance",
	"ColorTemperature",
	"Sharpness",
	"HighlightTone",
	"ShadowTone",
	"Color",
	"Clarity",
	"NoiseReduction",
	"ImageStabilization",
	"FocusMode",
	"AFMode",
	"MacroMode",
	"Quality",
	"ShutterType",
	"ExposureCount",
	"SequenceNumber",
];

async function testPickTags() {
	try {
		console.log("=== Attempting to extract Fujifilm tags with 'pick' ===\n");

		const result = await exifr.parse(filePath, {
			makerNote: true,
			pick: FUJI_TAGS,
		});

		console.log("Result:");
		console.log(JSON.stringify(result, null, 2));

		console.log("\n\n=== Trying with all options enabled ===\n");
		const result2 = await exifr.parse(filePath);
		
		const fujiKeys = Object.keys(result2 || {}).filter(k => {
			const lower = k.toLowerCase();
			return lower.includes("film") || lower.includes("grain") || 
			       lower.includes("chrome") || lower.includes("dynamic") ||
			       lower.includes("clarity") || lower.includes("highlight") ||
			       lower.includes("shadow") || lower.includes("color");
		});

		console.log("Keys with Fuji-related names:", fujiKeys);
		fujiKeys.forEach(k => {
			console.log(`  ${k}:`, result2[k]);
		});

	} catch (error) {
		console.error("Error:", error);
		process.exit(1);
	}
}

testPickTags();
