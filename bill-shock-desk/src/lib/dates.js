// Shutoff dates are calendar dates, not moments in time. We keep them as
// "YYYY-MM-DD" strings and do all arithmetic in whole UTC days so that
// daylight saving changes can never shift an answer by one.

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(s) {
  if (typeof s !== 'string') return false;
  const m = ISO.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** Whole days since 1970-01-01 for an ISO date. */
function dayNumber(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

/** Days from a to b. Positive when b is later. */
export function daysBetween(a, b) {
  return dayNumber(b) - dayNumber(a);
}

export function addDays(iso, n) {
  return new Date((dayNumber(iso) + n) * 86_400_000).toISOString().slice(0, 10);
}

/** Today's calendar date in the service area's time zone. */
export function todayIn(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function formatDate(iso, lang = 'en') {
  const d = new Date(dayNumber(iso) * 86_400_000);
  return d.toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export const monthOf = (iso) => Number(iso.slice(5, 7));

export function plusDaysIso(date, days) {
  return new Date(date.getTime() + days * 86_400_000).toISOString();
}
