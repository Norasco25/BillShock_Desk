import { HttpError } from '../lib/errors.js';
import { safeEqual } from '../lib/crypto.js';

export function applySecurityHeaders(res) {
  res.setHeader(
    'content-security-policy',
    "default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('cache-control', 'no-store');
}

export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * A fixed-window counter per key. Lives in memory, so it resets on restart and
 * is per-process. Good enough to blunt abuse of the endpoints that cost money.
 */
export function createRateLimiter({ now = () => Date.now() } = {}) {
  const buckets = new Map();

  const tooMany = (resetAt) =>
    new HttpError(429, 'Too many requests. Please wait a few minutes and try again.', {
      headers: { 'retry-after': String(Math.max(1, Math.ceil((resetAt - now()) / 1000))) },
    });

  /** Count one hit for `key`. Throws 429 once it passes `max` inside the window. */
  function limit({ key, max, windowMs }) {
    const t = now();
    const b = buckets.get(key);
    if (!b || b.resetAt <= t) {
      buckets.set(key, { count: 1, resetAt: t + windowMs });
      if (buckets.size > 10_000) for (const [k, v] of buckets) if (v.resetAt <= t) buckets.delete(k);
      return;
    }
    b.count += 1;
    if (b.count > max) throw tooMany(b.resetAt);
  }

  /** Throws 429 if `key` is already over `max`, without counting a hit. */
  limit.assertBelow = ({ key, max }) => {
    const b = buckets.get(key);
    if (b && b.resetAt > now() && b.count >= max) throw tooMany(b.resetAt);
  };

  return limit;
}

/**
 * HTTP Basic authentication for staff. Returns the staff member's name,
 * which is written to the audit log next to everything they do.
 */
export function createStaffAuth({ users, limit, trustProxy }) {
  return function authenticate(req) {
    const failKey = `authfail:${clientIp(req, trustProxy)}`;
    const failure = { key: failKey, max: 10, windowMs: 10 * 60 * 1000 };
    limit.assertBelow(failure); // after 10 wrong passwords, even the right one is refused for a while

    const challenge = { headers: { 'www-authenticate': 'Basic realm="Bill Shock Desk staff", charset="UTF-8"' } };
    const header = String(req.headers.authorization ?? '');
    if (!header.startsWith('Basic ')) throw new HttpError(401, 'Staff sign-in required.', challenge); // the browser's first, empty visit

    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    const name = i >= 0 ? decoded.slice(0, i) : '';
    const password = i >= 0 ? decoded.slice(i + 1) : '';

    // Check every user so the time taken does not reveal which names exist.
    let matched = null;
    for (const u of users) {
      const nameOk = safeEqual(u.name, name);
      const passOk = safeEqual(u.password, password);
      if (nameOk && passOk) matched = u.name;
    }
    if (!matched) {
      try { limit(failure); } catch { /* the next attempt will be refused */ }
      throw new HttpError(401, 'Wrong name or password.', challenge);
    }
    return matched;
  };
}
