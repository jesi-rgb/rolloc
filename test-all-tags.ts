/**
 * Dump all Fujifilm MakerNote tags to see what's available
 */
import exifr from "exifr";

const filePath = process.argv[2];

if (!filePath) {
	console.error("Usage: bun test-all-tags.ts <path-to-image>");
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

async function dumpAllTags() {
	try {
		const rawData = await exifr.parse(filePath, {
			makerNote: true,
			translateKeys: false,
			translateValues: false,
			mergeOutput: false,
		});

		const makerNote = rawData?.makerNote;
		
		if (!makerNote) {
			console.error("No MakerNote found");
			process.exit(1);
		}

		const header = String.fromCharCode(
			makerNote[0], makerNote[1], makerNote[2], makerNote[3],
			makerNote[4], makerNote[5], makerNote[6], makerNote[7]
		);

		if (header !== 'FUJIFILM') {
			console.error("Not a Fujifilm MakerNote");
			process.exit(1);
		}

		const ifdOffset = read32(makerNote, 8, true);
		const numEntries = read16(makerNote, ifdOffset, true);

		console.log(`Found ${numEntries} MakerNote tags:\n`);
		console.log("Tag ID (hex) | Type | Count | Value");
		console.log("-------------|------|-------|------");

		const tags: Array<{ tag: number; type: number; value: number }> = [];

		for (let i = 0; i < numEntries; i++) {
			const entryOffset = ifdOffset + 2 + i * 12;
			const tag = read16(makerNote, entryOffset, true);
			const type = read16(makerNote, entryOffset + 2, true);
			const count = read32(makerNote, entryOffset + 4, true);
			const valueOffset = entryOffset + 8;

			let value: number;
			if (type === 3) {
				value = read16(makerNote, valueOffset, true);
			} else if (type === 4) {
				value = read32(makerNote, valueOffset, true);
			} else if (type === 9) {
				const unsigned = read32(makerNote, valueOffset, true);
				value = unsigned > 0x7fffffff ? unsigned - 0x100000000 : unsigned;
			} else {
				continue;
			}

			tags.push({ tag, type, value });

			const tagHex = `0x${tag.toString(16).toUpperCase().padStart(4, '0')}`;
			const typeStr = type === 3 ? 'SHORT' : type === 4 ? 'LONG' : type === 9 ? 'SLONG' : `TYPE${type}`;
			console.log(`${tagHex.padEnd(13)}| ${typeStr.padEnd(5)}| ${count.toString().padEnd(6)}| ${value} (0x${value.toString(16).toUpperCase()})`);
		}

		console.log("\n=== Tags in range 0x1400-0x1450 (Fuji image settings) ===");
		const imageSettingsTags = tags.filter(t => t.tag >= 0x1400 && t.tag <= 0x1450);
		imageSettingsTags.forEach(({ tag, value }) => {
			const tagHex = `0x${tag.toString(16).toUpperCase().padStart(4, '0')}`;
			console.log(`${tagHex}: ${value} (0x${value.toString(16).toUpperCase()})`);
		});

	} catch (error) {
		console.error("Error:", error);
		process.exit(1);
	}
}

dumpAllTags();
