// Money is stored as whole cents (integers) so rounding errors cannot creep in.

/** Accepts 412.18, "412.18", "$1,412.18". Returns cents or null. */
export function parseDollarsToCents(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    return Math.round(value * 100);
  }
  if (typeof value !== 'string') return null;
  const s = value.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
}

export function formatCents(cents) {
  return (
    '$' +
    (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

export const centsToDollarString = (cents) => (cents / 100).toFixed(2);
