import { samePhone } from '../lib/phone.js';
import { isFresh } from './library.js';

const REF = /\[ref:([A-Za-z0-9_-]+)\]/g;
// 555-0100, 555-010-0100, (555) 010-0100, 555.010.0100
const PHONE = /\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b|\b\d{3}-\d{4}\b/g;

/**
 * Proves a draft only states things we can trace:
 *   - every [ref:ID] points to a library entry that exists and is up to date
 *   - every phone number is one from the library, the notice, or the household
 *
 * @param {string} text
 * @param {{ entriesById: Record<string,object>, today: string, allowedPhones: string[] }} ctx
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function checkTraceable(text, { entriesById, today, allowedPhones }) {
  const problems = [];

  for (const [, id] of String(text).matchAll(REF)) {
    const entry = entriesById[id];
    if (!entry) problems.push(`Cites "${id}", which is not in the library.`);
    else if (!isFresh(entry, today)) problems.push(`Cites "${id}", which is inactive or out of date.`);
  }

  for (const [number] of String(text).matchAll(PHONE)) {
    if (!allowedPhones.some((p) => p && samePhone(p, number))) {
      problems.push(`Phone number ${number.trim()} is not in the library, on the notice, or given by the household.`);
    }
  }

  return { ok: problems.length === 0, problems };
}
