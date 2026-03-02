import type { FujifilmSettings } from "$lib/image/fuji-makernote";

export interface ExifData {
	make?: string;
	model?: string;
	lensModel?: string;
	iso?: number;
	fNumber?: number;
	exposureTime?: number;
	focalLength?: number;
	dateTime?: string;
	exposureCompensation?: number;
	// Fujifilm-specific fields
	fuji?: FujifilmSettings;
}
