/**
 * Libraries module tests.
 *
 * These run in the "server" Vitest project because they test the business
 * logic of library operations, not the actual filesystem or IndexedDB.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rescanLibrary } from './libraries';
import * as idb from './idb';
import * as directory from '$lib/fs/directory';
import type { LibraryImage } from '$lib/types';

// Mock the modules
vi.mock('./idb');
vi.mock('$lib/fs/directory');

describe('rescanLibrary', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('should add new images found in directory', async () => {
		const libraryId = 'lib-123';
		const dirPath = '/path/to/library';

		// Existing images in DB
		const existingImages: LibraryImage[] = [
			{
				id: 'img-1',
				libraryId,
				filename: 'photo1.jpg',
				index: 0,
				rating: 0,
				notes: '',
				createdAt: 1000,
			},
			{
				id: 'img-2',
				libraryId,
				filename: 'photo2.jpg',
				index: 1,
				rating: 3,
				notes: 'Nice shot',
				createdAt: 1001,
			},
		];

		// Files found in directory (includes existing + new)
		const filesInDirectory = [
			{ filename: 'photo1.jpg', relativePath: 'photo1.jpg' },
			{ filename: 'photo2.jpg', relativePath: 'photo2.jpg' },
			{ filename: 'photo3.jpg', relativePath: 'photo3.jpg' },
			{ filename: 'photo4.jpg', relativePath: 'photo4.jpg' },
		];

		// Mock IDB functions
		vi.mocked(idb.getPath).mockResolvedValue(dirPath);
		vi.mocked(idb.getImages).mockResolvedValue(existingImages);
		vi.mocked(idb.putImages).mockResolvedValue(undefined);

		// Mock directory scan
		vi.mocked(directory.listImageFiles).mockResolvedValue(filesInDirectory);

		const newCount = await rescanLibrary(libraryId);

		// Should return 2 (photo3.jpg and photo4.jpg)
		expect(newCount).toBe(2);

		// Verify putImages was called with new images
		expect(idb.putImages).toHaveBeenCalledTimes(1);
		const savedImages = vi.mocked(idb.putImages).mock.calls[0][0];
		expect(savedImages).toHaveLength(2);
		expect(savedImages[0].filename).toBe('photo3.jpg');
		expect(savedImages[1].filename).toBe('photo4.jpg');

		// Verify new images have correct indices (continuing from max existing)
		expect(savedImages[0].index).toBe(2);
		expect(savedImages[1].index).toBe(3);

		// Verify new images have IDs and timestamps
		expect(savedImages[0].id).toBeDefined();
		expect(savedImages[1].id).toBeDefined();
		expect(savedImages[0].createdAt).toBeDefined();
		expect(savedImages[1].createdAt).toBeDefined();
	});

	it('should return 0 when no new images found', async () => {
		const libraryId = 'lib-123';
		const dirPath = '/path/to/library';

		const existingImages: LibraryImage[] = [
			{
				id: 'img-1',
				libraryId,
				filename: 'photo1.jpg',
				index: 0,
				rating: 0,
				notes: '',
				createdAt: 1000,
			},
		];

		const filesInDirectory = [{ filename: 'photo1.jpg', relativePath: 'photo1.jpg' }];

		vi.mocked(idb.getPath).mockResolvedValue(dirPath);
		vi.mocked(idb.getImages).mockResolvedValue(existingImages);
		vi.mocked(directory.listImageFiles).mockResolvedValue(filesInDirectory);

		const newCount = await rescanLibrary(libraryId);

		expect(newCount).toBe(0);
		expect(idb.putImages).not.toHaveBeenCalled();
	});

	it('should throw error if library path not found', async () => {
		const libraryId = 'lib-123';

		vi.mocked(idb.getPath).mockResolvedValue(undefined);

		await expect(rescanLibrary(libraryId)).rejects.toThrow('Library path not found');
	});

	it('should handle empty library correctly', async () => {
		const libraryId = 'lib-123';
		const dirPath = '/path/to/library';

		const filesInDirectory = [
			{ filename: 'photo1.jpg', relativePath: 'photo1.jpg' },
			{ filename: 'photo2.jpg', relativePath: 'photo2.jpg' },
		];

		vi.mocked(idb.getPath).mockResolvedValue(dirPath);
		vi.mocked(idb.getImages).mockResolvedValue([]);
		vi.mocked(idb.putImages).mockResolvedValue(undefined);
		vi.mocked(directory.listImageFiles).mockResolvedValue(filesInDirectory);

		const newCount = await rescanLibrary(libraryId);

		expect(newCount).toBe(2);

		const savedImages = vi.mocked(idb.putImages).mock.calls[0][0];
		// Indices should start from 0
		expect(savedImages[0].index).toBe(0);
		expect(savedImages[1].index).toBe(1);
	});

	it('should preserve existing image metadata', async () => {
		const libraryId = 'lib-123';
		const dirPath = '/path/to/library';

		// Existing image with custom metadata
		const existingImages: LibraryImage[] = [
			{
				id: 'img-1',
				libraryId,
				filename: 'photo1.jpg',
				index: 0,
				rating: 5,
				notes: 'Important photo',
				createdAt: 1000,
			},
		];

		const filesInDirectory = [
			{ filename: 'photo1.jpg', relativePath: 'photo1.jpg' },
			{ filename: 'photo2.jpg', relativePath: 'photo2.jpg' },
		];

		vi.mocked(idb.getPath).mockResolvedValue(dirPath);
		vi.mocked(idb.getImages).mockResolvedValue(existingImages);
		vi.mocked(idb.putImages).mockResolvedValue(undefined);
		vi.mocked(directory.listImageFiles).mockResolvedValue(filesInDirectory);

		await rescanLibrary(libraryId);

		// Only new image should be saved
		const savedImages = vi.mocked(idb.putImages).mock.calls[0][0];
		expect(savedImages).toHaveLength(1);
		expect(savedImages[0].filename).toBe('photo2.jpg');

		// Existing image's metadata should NOT be in the saved images
		// (it's preserved in the database, we only add new images)
		expect(savedImages.find((img) => img.filename === 'photo1.jpg')).toBeUndefined();
	});
});
