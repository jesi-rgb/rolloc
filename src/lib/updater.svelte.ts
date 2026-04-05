/**
 * Auto-update module for Tauri builds.
 * Checks for updates on startup and exposes reactive state for UI.
 */

import type { Update } from '@tauri-apps/plugin-updater';

/** True when running inside a Tauri WebView (not a plain browser). */
function isTauri(): boolean {
	return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Reactive state for the updater. */
let availableUpdate: Update | null = $state(null);
let checking: boolean = $state(false);
let downloading: boolean = $state(false);
let error: string | null = $state(null);

/** Whether an update is available. */
export function getAvailableUpdate(): Update | null {
	return availableUpdate;
}

/** Whether we're currently checking for updates. */
export function isChecking(): boolean {
	return checking;
}

/** Whether we're currently downloading/installing an update. */
export function isDownloading(): boolean {
	return downloading;
}

/** Any error that occurred during update check. */
export function getError(): string | null {
	return error;
}

/**
 * Check for updates. Safe to call from browser (no-op).
 * Returns the update if available, null otherwise.
 */
export async function checkForUpdate(): Promise<Update | null> {
	if (!isTauri()) return null;

	checking = true;
	error = null;

	try {
		const { check } = await import('@tauri-apps/plugin-updater');
		const update = await check();
		availableUpdate = update;
		return update;
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
		console.error('[updater] Failed to check for updates:', e);
		return null;
	} finally {
		checking = false;
	}
}

/**
 * Download and install the available update.
 * The app will restart after installation.
 */
export async function installUpdate(): Promise<void> {
	if (!availableUpdate) return;

	downloading = true;
	error = null;

	try {
		// downloadAndInstall() will restart the app on completion
		await availableUpdate.downloadAndInstall();
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
		console.error('[updater] Failed to install update:', e);
		downloading = false;
	}
}

/** Dismiss the update notification (user chose to skip). */
export function dismissUpdate(): void {
	availableUpdate = null;
}

/**
 * Initialize the updater — call once on app startup.
 * Checks for updates in the background.
 */
export function initUpdater(): void {
	if (!isTauri()) return;
	// Check after a short delay to not block startup
	setTimeout(() => {
		checkForUpdate();
	}, 3000);
}
