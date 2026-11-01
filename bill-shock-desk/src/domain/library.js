import { addDays, daysBetween, isIsoDate, monthOf } from '../lib/dates.js';

// The rule and program library: every fact a plan may state comes from here.
// Each entry carries a source link and a "last verified" date. After `ttlDays`
// the entry is treated as out of date and stops appearing in plans until a
// staff member re-checks it.

export const KINDS = ['payment_plan', 'protection', 'assistance'];
export const INCOMES = ['low', 'mid', 'high'];

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * "who is this for". Example: { "senior": true } or
 * { "any": [ { "incomeIn": ["low"] }, { "incomeIn": ["mid"], "minSize": 4 } ] }.
 * All keys in one condition must match. `any` means at least one condition matches.
 */
export function validateWhen(when, depth = 0) {
  const errors = [];
  if (when === undefined) return { ok: true, errors, value: {} };
  if (!isPlain(when)) return { ok: false, errors: ['"when" must be an object'], value: {} };

  const keys = Object.keys(when);
  if ('any' in when) {
    if (depth > 0 || keys.length !== 1) {
      errors.push('"any" must be the only key and cannot be nested');
    } else if (!Array.isArray(when.any) || when.any.length === 0 || when.any.length > 10) {
      errors.push('"any" must be a list of 1 to 10 conditions');
    } else {
      when.any.forEach((w, i) => {
        validateWhen(w, depth + 1).errors.forEach((e) => errors.push(`any[${i}]: ${e}`));
      });
    }
    return { ok: errors.length === 0, errors, value: when };
  }

  for (const [k, v] of Object.entries(when)) {
    switch (k) {
      case 'medical':
      case 'minor':
      case 'senior':
        if (typeof v !== 'boolean') errors.push(`${k} must be true or false`);
        break;
      case 'incomeIn':
        if (!Array.isArray(v) || v.length === 0 || !v.every((x) => INCOMES.includes(x))) {
          errors.push(`incomeIn must be a list of: ${INCOMES.join(', ')}`);
        }
        break;
      case 'minSize':
      case 'maxSize':
        if (!Number.isInteger(v) || v < 1 || v > 30) errors.push(`${k} must be a whole number from 1 to 30`);
        break;
      case 'shutoffMonthsIn':
        if (!Array.isArray(v) || v.length === 0 || !v.every((x) => Number.isInteger(x) && x >= 1 && x <= 12)) {
          errors.push('shutoffMonthsIn must be a list of month numbers from 1 to 12');
        }
        break;
      case 'minAmountCents':
        if (!Number.isInteger(v) || v < 0) errors.push('minAmountCents must be a whole number of cents');
        break;
      default:
        errors.push(`unknown condition "${k}"`);
    }
  }
  return { ok: errors.length === 0, errors, value: when };
}

/** Does this household match the entry's "who is this for" condition? */
export function evaluateWhen(when, ctx) {
  if (!when || Object.keys(when).length === 0) return true;
  if (when.any) return when.any.some((w) => evaluateWhen(w, ctx));
  return Object.entries(when).every(([k, v]) => {
    switch (k) {
      case 'medical': return Boolean(ctx.medical) === v;
      case 'minor': return Boolean(ctx.minor) === v;
      case 'senior': return Boolean(ctx.senior) === v;
      case 'incomeIn': return v.includes(ctx.income);
      case 'minSize': return ctx.size >= v;
      case 'maxSize': return ctx.size <= v;
      case 'shutoffMonthsIn': return v.includes(monthOf(ctx.shutoffDate));
      case 'minAmountCents': return ctx.amountCents >= v;
      default: return false; // an unknown condition never matches
    }
  });
}

export const expiresOn = (entry) => addDays(entry.verifiedOn, entry.ttlDays);
export const isFresh = (entry, today) => entry.active && daysBetween(entry.verifiedOn, today) <= entry.ttlDays;

const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/** Checks a library entry typed in by staff. Returns every problem at once. */
export function validateEntry(input, { today }) {
  const errors = [];
  const e = input ?? {};

  if (!/^[A-Za-z0-9_-]{2,40}$/.test(e.id ?? '')) errors.push('id must be 2 to 40 letters, numbers, dashes or underscores');
  if (!/^[A-Za-z0-9_-]{2,40}$/.test(e.utilityId ?? '')) errors.push('utilityId is required');
  if (!KINDS.includes(e.kind)) errors.push(`kind must be one of: ${KINDS.join(', ')}`);
  if (!Number.isInteger(e.rank) || e.rank < 0 || e.rank > 1000) errors.push('rank must be a whole number from 0 to 1000');
  for (const f of ['titleEn', 'titleEs']) if (!text(e[f], 200)) errors.push(`${f} is required (up to 200 characters)`);
  for (const f of ['bodyEn', 'bodyEs']) if (!text(e[f], 2000)) errors.push(`${f} is required (up to 2000 characters)`);
  if (e.phone && !/^[\d\-\s().+]{7,20}$/.test(e.phone)) errors.push('phone looks wrong');
  if (!Array.isArray(e.documents) || e.documents.length > 20 || !e.documents.every((d) => text(d, 200))) {
    errors.push('documents must be a list of up to 20 short items');
  }
  for (const f of ['askLetter', 'askScriptEn', 'askScriptEs']) {
    if (typeof e[f] !== 'string' || e[f].length > 500) errors.push(`${f} must be text up to 500 characters`);
  }
  const when = validateWhen(e.when);
  when.errors.forEach((m) => errors.push(`when: ${m}`));

  try {
    const url = new URL(e.sourceUrl);
    if (url.protocol !== 'https:') errors.push('sourceUrl must start with https://');
  } catch {
    errors.push('sourceUrl must be a full link, for example https://example.gov/page');
  }
  if (!isIsoDate(e.verifiedOn)) errors.push('verifiedOn must be a date like 2026-10-31');
  else if (daysBetween(e.verifiedOn, today) < 0) errors.push('verifiedOn cannot be in the future');
  if (!text(e.verifiedBy, 100)) errors.push('verifiedBy is required: who checked the source');
  if (!Number.isInteger(e.ttlDays) || e.ttlDays < 1 || e.ttlDays > 730) errors.push('ttlDays must be from 1 to 730');

  return {
    ok: errors.length === 0,
    errors,
    value: {
      id: e.id,
      utilityId: e.utilityId,
      kind: e.kind,
      rank: e.rank,
      titleEn: e.titleEn?.trim(),
      titleEs: e.titleEs?.trim(),
      bodyEn: e.bodyEn?.trim(),
      bodyEs: e.bodyEs?.trim(),
      phone: e.phone?.trim() || null,
      documents: e.documents,
      when: e.when ?? {},
      askLetter: e.askLetter ?? '',
      askScriptEn: e.askScriptEn ?? '',
      askScriptEs: e.askScriptEs ?? '',
      sourceUrl: e.sourceUrl,
      verifiedOn: e.verifiedOn,
      verifiedBy: e.verifiedBy?.trim(),
      ttlDays: e.ttlDays,
      active: e.active === false ? false : true,
    },
  };
}
