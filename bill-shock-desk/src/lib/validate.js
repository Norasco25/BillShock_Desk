import { HttpError } from './errors.js';

// Small input checkers. Every public endpoint runs its input through these
// before it reaches the database.

export function asObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new HttpError(400, 'Expected a JSON object.');
  }
  return v;
}

export function asString(v, name, { min = 0, max = 1000, optional = false, trim = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return null;
    throw new HttpError(400, `${name} is required.`);
  }
  if (typeof v !== 'string') throw new HttpError(400, `${name} must be text.`);
  const s = trim ? v.trim() : v;
  if (s.length < min || s.length > max) {
    throw new HttpError(400, `${name} must be between ${min} and ${max} characters.`);
  }
  return s;
}

export function asInt(v, name, { min, max }) {
  const n = typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : v;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${name} must be a whole number from ${min} to ${max}.`);
  }
  return n;
}

export function asBool(v, name) {
  if (typeof v !== 'boolean') throw new HttpError(400, `${name} must be true or false.`);
  return v;
}

export function asOneOf(v, name, list, { fallback } = {}) {
  if ((v === undefined || v === null) && fallback !== undefined) return fallback;
  if (!list.includes(v)) throw new HttpError(400, `${name} must be one of: ${list.join(', ')}.`);
  return v;
}
