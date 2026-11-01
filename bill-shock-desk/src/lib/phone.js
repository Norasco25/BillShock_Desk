export const digitsOf = (s) => String(s ?? '').replace(/\D/g, '');

/** US numbers only. Returns "+1XXXXXXXXXX" or null. */
export function normalizePhone(value) {
  if (typeof value !== 'string') return null;
  const d = digitsOf(value);
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return null;
}

/** "(555) 010-0142" for display and for letters. */
export function formatPhone(e164) {
  const d = digitsOf(e164).slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : e164;
}

/**
 * True when two numbers are the same line. A seven-digit local number
 * ("555-0100") matches a ten-digit number that ends with it.
 */
export function samePhone(a, b) {
  const x = digitsOf(a);
  const y = digitsOf(b);
  if (!x || !y) return false;
  if (x.length >= 10 && y.length >= 10) return x.slice(-10) === y.slice(-10);
  return x.length < y.length ? y.endsWith(x) : x.endsWith(y);
}
