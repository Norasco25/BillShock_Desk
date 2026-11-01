import { isIsoDate } from '../lib/dates.js';
import { parseDollarsToCents } from '../lib/money.js';
import { scanText } from './urgency.js';

// Reads the key facts out of a notice's text with plain pattern matching.
// It understands notices that label their fields ("Amount past due: $412.18").
// Notices laid out differently are handled by the AI reader in services/ai.js.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function parseNoticeDate(raw) {
  const s = String(raw ?? '').trim();
  let m;
  let iso = null;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) {
    iso = s;
  } else if ((m = /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s))) {
    const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    if (mi >= 0) iso = `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  } else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) {
    iso = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  return iso && isIsoDate(iso) ? iso : null;
}

const DATE_WORDS = String.raw`([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})`;
const LABELS = {
  holder: /(?:account holder|customer name|name on account|account name)\s*[:\-]\s*(.+)/i,
  amount: /(?:amount past due|past due amount|total past due|balance past due|amount due)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
  date: new RegExp(
    String.raw`(?:disconnection date|disconnect date|shut-?off date|disconnect after|service will be (?:disconnected|shut off) on)\s*[:\-]?\s*` +
      DATE_WORDS,
    'i',
  ),
  phone: /(\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}|\b\d{3}-\d{4}\b)/,
};

/** Which known utility does this text name? Returns its id or null. */
export function matchUtility(text, utilities) {
  for (const u of utilities) {
    if (u.patterns.some((p) => new RegExp(p, 'i').test(text))) return u.id;
  }
  return null;
}

/**
 * @returns {{ok:true, fields:object, urgency:string[], transcription:string}
 *          | {ok:false, reason:'unreadable', missing:string[]}}
 */
export function extractFromText(text, utilities) {
  const t = String(text ?? '');
  const holder = LABELS.holder.exec(t)?.[1]?.trim().replace(/[.;,]+$/, '') || null;
  const amountCents = (() => {
    const m = LABELS.amount.exec(t);
    return m ? parseDollarsToCents(m[1]) : null;
  })();
  const shutoffDate = (() => {
    const m = LABELS.date.exec(t);
    return m ? parseNoticeDate(m[1]) : null;
  })();

  const missing = [];
  if (!holder) missing.push('account_holder');
  if (amountCents === null) missing.push('amount_past_due');
  if (!shutoffDate) missing.push('shutoff_date');
  if (missing.length) return { ok: false, reason: 'unreadable', missing };

  const firstLine = t.split('\n').map((l) => l.trim()).find(Boolean) || null;
  return {
    ok: true,
    fields: {
      utilityId: matchUtility(t, utilities),
      utilityNameOnNotice: firstLine ? firstLine.slice(0, 100) : null,
      holder,
      amountCents,
      shutoffDate,
      noticePhone: LABELS.phone.exec(t)?.[1] ?? null,
    },
    urgency: scanText(t),
    transcription: t,
  };
}
