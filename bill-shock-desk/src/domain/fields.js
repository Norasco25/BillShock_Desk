import { daysBetween, isIsoDate } from '../lib/dates.js';
import { parseDollarsToCents } from '../lib/money.js';

const MAX_CENTS = 10_000_000; // $100,000: anything bigger is almost certainly a misread

/**
 * Checks the four facts a notice must give us. The same function checks
 * values typed by a household, values read by pattern matching and values read
 * by AI, so nothing reaches the database without passing the same rules.
 *
 * @returns {{ ok: boolean, errors: Record<string,string>, value: object }}
 */
export function validateFields(input, utilities, { today } = {}) {
  const errors = {};
  const value = {};

  const holder = typeof input.holder === 'string' ? input.holder.trim().replace(/\s+/g, ' ') : '';
  // eslint-disable-next-line no-control-regex
  if (!holder || holder.length > 100 || /[\u0000-\u001f]/.test(holder)) {
    errors.holder = 'Enter the name on the account (up to 100 characters).';
  } else {
    value.holder = holder;
  }

  const cents =
    input.amountCents !== undefined ? input.amountCents : parseDollarsToCents(input.amount);
  if (!Number.isInteger(cents) || cents < 1 || cents > MAX_CENTS) {
    errors.amount = 'Enter the amount past due, between $0.01 and $100,000.';
  } else {
    value.amountCents = cents;
  }

  if (!isIsoDate(input.shutoffDate)) {
    errors.shutoffDate = 'Enter the shutoff date as YYYY-MM-DD.';
  } else if (today && (daysBetween(today, input.shutoffDate) < -30 || daysBetween(today, input.shutoffDate) > 120)) {
    errors.shutoffDate = 'That date looks wrong. Check the year on your notice.';
  } else {
    value.shutoffDate = input.shutoffDate;
  }

  if (input.utilityId === null || input.utilityId === undefined || input.utilityId === '') {
    value.utilityId = null;
  } else if (utilities.some((u) => u.id === input.utilityId)) {
    value.utilityId = input.utilityId;
  } else {
    errors.utilityId = 'Unknown utility.';
  }

  if (typeof input.noticePhone === 'string' && /^[\d\-\s().+]{7,20}$/.test(input.noticePhone.trim())) {
    value.noticePhone = input.noticePhone.trim();
  } else {
    value.noticePhone = null;
  }

  return { ok: Object.keys(errors).length === 0, errors, value };
}
