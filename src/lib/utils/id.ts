/**
 * Generates a URL-safe random ID using the Web Crypto API.
 * 21 characters, ~126 bits of entropy — equivalent to nanoid's default.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function nanoid(size = 21): string {
	const bytes = crypto.getRandomValues(new Uint8Array(size));
	return Array.from(bytes, (b) => ALPHABET[b & 63]).join('');
}
