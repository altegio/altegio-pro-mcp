/**
 * `f44336`, `#F44336` → `#f44336`. The API writes colors with and without the
 * `#` and in either case; tools speak `#rrggbb`. Anything that is not six hex
 * digits (including the empty string the API uses for "no color") → null.
 */
export function hexColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const digits = value.trim().replace(/^#/, '').toLowerCase();
  return /^[0-9a-f]{6}$/.test(digits) ? `#${digits}` : null;
}
