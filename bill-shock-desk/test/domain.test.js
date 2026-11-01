import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { addDays, daysBetween, formatDate, isIsoDate, todayIn } from '../src/lib/dates.js';
import { formatCents, parseDollarsToCents } from '../src/lib/money.js';
import { formatPhone, normalizePhone, samePhone } from '../src/lib/phone.js';
import { decrypt, encrypt, hashToken, newToken } from '../src/lib/crypto.js';
import { extractFromText, parseNoticeDate } from '../src/domain/extract.js';
import { scanText } from '../src/domain/urgency.js';
import { evaluateWhen, isFresh, validateEntry, validateWhen } from '../src/domain/library.js';
import { buildPlan, publicPlan } from '../src/domain/plan.js';
import { buildDrafts, stripRefs } from '../src/domain/drafts.js';
import { checkTraceable } from '../src/domain/traceability.js';
import { evaluateGate } from '../src/domain/gate.js';
import { validateFields } from '../src/domain/fields.js';
import { twilioSignature, verifyTwilioSignature, parseKeyword } from '../src/services/messaging.js';
import { createExtractor, parseAiResult } from '../src/services/ai.js';
import { notice, SEED_FILE, testConfig } from './helpers.js';

const TODAY = '2026-10-31';
const UTILITIES = [{ id: 'epl', name: 'Example Power & Light', state: 'EX', patterns: ['example\\s+power\\s*&\\s*light'] }];
const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
const entries = (verifiedOn = '2026-10-20') =>
  seed.entries.map((e) => validateEntry({ ...e, verifiedOn }, { today: TODAY }).value);
const byId = (list) => Object.fromEntries(list.map((e) => [e.id, e]));
const ctx = (over = {}) => ({
  holder: 'Dee Carter', amountCents: 30_000, shutoffDate: '2026-11-05', utilityNameOnNotice: 'Example Power & Light',
  noticePhone: '555-0100', size: 3, income: 'low', medical: false, minor: false, senior: false, phone: '+15550100142', ...over,
});
const planFor = (c, list = entries(), utility = UTILITIES[0]) =>
  buildPlan({ ctx: c, utility, entries: list, today: TODAY, largeBalanceCents: 40_000 });

test('dates: whole-day math ignores daylight saving', () => {
  assert.equal(daysBetween('2026-10-31', '2026-11-05'), 5);
  assert.equal(daysBetween('2026-03-07', '2026-03-09'), 2); // spans the spring clock change
  assert.equal(daysBetween('2026-11-05', '2026-10-31'), -5);
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
  assert.ok(isIsoDate('2028-02-29'));
  assert.ok(!isIsoDate('2026-02-30'));
  assert.ok(!isIsoDate('11/05/2026'));
});

test('dates: "today" follows the service area, not UTC', () => {
  // 03:30 UTC on Nov 1 is still the evening of Oct 31 in New York.
  assert.equal(todayIn('America/New_York', new Date('2026-11-01T03:30:00Z')), '2026-10-31');
  assert.equal(todayIn('UTC', new Date('2026-11-01T03:30:00Z')), '2026-11-01');
  assert.equal(formatDate('2026-11-05', 'en'), 'November 5, 2026');
  assert.equal(formatDate('2026-11-05', 'es'), '5 de noviembre de 2026');
});

test('money and phone helpers', () => {
  assert.equal(parseDollarsToCents('$1,412.18'), 141_218);
  assert.equal(parseDollarsToCents(412.18), 41_218);
  assert.equal(parseDollarsToCents('12.345'), null);
  assert.equal(parseDollarsToCents('abc'), null);
  assert.equal(formatCents(41_218), '$412.18');
  assert.equal(normalizePhone('(555) 010-0142'), '+15550100142');
  assert.equal(normalizePhone('12345'), null);
  assert.equal(formatPhone('+15550100142'), '(555) 010-0142');
  assert.ok(samePhone('010-0142', '+15550100142'));
  assert.ok(!samePhone('555-9999', '+15550100142'));
});

test('crypto: round trip, tamper detection, token hashing', () => {
  const key = Buffer.alloc(32, 7);
  const blob = encrypt(key, 'Dee Carter, account 123');
  assert.equal(decrypt(key, blob).toString(), 'Dee Carter, account 123');
  assert.ok(!blob.includes('Dee Carter')); // not stored in the clear
  const tampered = Buffer.from(blob);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decrypt(key, tampered));
  assert.throws(() => decrypt(Buffer.alloc(32, 8), blob));
  const t = newToken();
  assert.notEqual(hashToken(t), t);
  assert.equal(hashToken(t), hashToken(t));
});

test('extract: reads a labeled notice', () => {
  const r = extractFromText(notice(), UTILITIES);
  assert.ok(r.ok);
  assert.equal(r.fields.holder, 'Dee Carter');
  assert.equal(r.fields.amountCents, 41_218);
  assert.equal(r.fields.shutoffDate, '2026-11-05');
  assert.equal(r.fields.utilityId, 'epl');
  assert.equal(r.fields.noticePhone, '555-0100');
  assert.deepEqual(r.urgency, []);
});

test('extract: other date styles, and an unknown utility is still readable', () => {
  assert.equal(parseNoticeDate('11/05/2026'), '2026-11-05');
  assert.equal(parseNoticeDate('Nov. 5, 2026'), '2026-11-05');
  assert.equal(parseNoticeDate('2026-11-05'), '2026-11-05');
  assert.equal(parseNoticeDate('February 30, 2026'), null);
  const r = extractFromText('Acme Gas\nCustomer name: Sam Lee\nPast due amount: $90.00\nShutoff date: 11/09/2026', UTILITIES);
  assert.ok(r.ok);
  assert.equal(r.fields.utilityId, null);
  assert.equal(r.fields.utilityNameOnNotice, 'Acme Gas');
});

test('extract: a blurry notice asks for a retake instead of guessing', () => {
  const blurry = 'EXAMP?E P0WER\nAcc0unt h**der: M. Ro?a\nAm0u?t p?st d?e: $6?5.??\nD!sc?nn?ct d??e: Nov ??, 2026';
  const r = extractFromText(blurry, UTILITIES);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['account_holder', 'amount_past_due', 'shutoff_date']);
});

test('urgency: keyword scan', () => {
  assert.deepEqual(scanText(notice({ extra: 'An oxygen concentrator is used at this address.' })), ['medical_equipment']);
  assert.ok(scanText('Heat advisory in effect').includes('extreme_weather'));
  assert.ok(scanText('two children live here').includes('minor_in_home'));
  assert.ok(scanText('elderly resident').includes('elderly_resident'));
  assert.deepEqual(scanText(notice()), []);
});

test('library: who-is-this-for rules', () => {
  const c = ctx({ income: 'mid', size: 4 });
  assert.ok(evaluateWhen({}, c));
  assert.ok(evaluateWhen({ senior: false }, c));
  assert.ok(!evaluateWhen({ senior: true }, c));
  assert.ok(evaluateWhen({ any: [{ incomeIn: ['low'] }, { incomeIn: ['mid'], minSize: 4 }] }, c));
  assert.ok(!evaluateWhen({ any: [{ incomeIn: ['low'] }, { incomeIn: ['mid'], minSize: 5 }] }, c));
  assert.ok(evaluateWhen({ shutoffMonthsIn: [11, 12] }, c));
  assert.ok(!evaluateWhen({ shutoffMonthsIn: [6, 7] }, c));
  assert.ok(!evaluateWhen({ nonsense: true }, c), 'an unknown condition never matches');
  assert.ok(!validateWhen({ nonsense: true }).ok);
  assert.ok(!validateWhen({ any: [{ any: [] }] }).ok);
  assert.ok(!validateWhen({ incomeIn: ['rich'] }).ok);
});

test('library: freshness window and entry validation', () => {
  const e = { active: true, verifiedOn: '2026-08-02', ttlDays: 90 };
  assert.ok(isFresh(e, '2026-10-31')); // day 90 still counts
  assert.ok(!isFresh(e, '2026-11-01')); // day 91 does not
  assert.ok(!isFresh({ ...e, active: false }, '2026-10-31'));

  const good = { ...seed.entries[0], verifiedOn: TODAY };
  assert.ok(validateEntry(good, { today: TODAY }).ok);
  const bad = validateEntry(
    { ...good, sourceUrl: 'http://insecure.example', verifiedOn: '2026-12-01', ttlDays: 0, kind: 'discount', verifiedBy: '' },
    { today: TODAY },
  );
  assert.ok(!bad.ok);
  assert.ok(bad.errors.length >= 5, bad.errors.join(' | '));
});

test('fields: typed values are validated like read values', () => {
  const ok = validateFields({ holder: '  Dee   Carter ', amount: '412.18', shutoffDate: '2026-11-05', utilityId: 'epl' }, UTILITIES, { today: TODAY });
  assert.ok(ok.ok);
  assert.equal(ok.value.holder, 'Dee Carter');
  const bad = validateFields({ holder: '', amount: '-5', shutoffDate: '2031-01-01', utilityId: 'nope' }, UTILITIES, { today: TODAY });
  assert.deepEqual(Object.keys(bad.errors).sort(), ['amount', 'holder', 'shutoffDate', 'utilityId']);
});

test('plan: deadline first, library steps in rank order, nothing invented', () => {
  const plan = planFor(ctx({ medical: true, senior: false }));
  const kinds = plan.steps.map((s) => s.kind);
  assert.equal(kinds[0], 'deadline');
  assert.deepEqual(
    plan.steps.filter((s) => s.kind === 'entry').map((s) => s.entryId),
    ['EPL-MEDCERT', 'EPL-COLD', 'EPL-PAYPLAN', 'EPL-FUND'],
  );
  assert.equal(plan.needsStaff, false);
  assert.ok(plan.steps[0].body.en.includes('5 days'));
  // Every entry step carries its source and verification date.
  for (const s of plan.steps.filter((x) => x.kind === 'entry')) {
    assert.ok(s.sourceUrl.startsWith('https://'));
    assert.equal(s.verifiedOn, '2026-10-20');
  }
});

test('plan: who it applies to', () => {
  const ids = (c) => planFor(c).steps.filter((s) => s.kind === 'entry').map((s) => s.entryId);
  assert.ok(!ids(ctx()).includes('EPL-MEDCERT'));
  assert.ok(ids(ctx({ senior: true })).includes('EPL-SENIOR'));
  assert.ok(!ids(ctx({ income: 'high' })).includes('EPL-FUND'));
  assert.ok(ids(ctx({ income: 'mid', size: 4 })).includes('EPL-FUND'));
  assert.ok(!ids(ctx({ shutoffDate: '2026-07-15' })).includes('EPL-COLD')); // not in cold-weather months
});

test('plan: out-of-date entries and gaps go to a human', () => {
  const stale = planFor(ctx({ senior: true }), entries('2026-01-01'));
  assert.ok(stale.needsStaff);
  assert.ok(stale.steps.every((s) => s.kind !== 'entry'), 'no stale entry is shown as fact');
  assert.ok(stale.steps.some((s) => s.kind === 'stale' && s.human && s.why.includes('out of date')));

  const none = planFor(ctx(), []);
  assert.ok(none.steps.some((s) => s.kind === 'gap' && s.why.includes('no active payment plan')));

  const unknown = planFor(ctx(), entries(), null);
  assert.equal(unknown.steps.length, 2);
  assert.ok(unknown.steps[1].why.includes('not in the library'));

  const big = planFor(ctx({ amountCents: 41_218 }));
  assert.ok(big.steps.some((s) => s.kind === 'gap' && s.why.includes('$412.18')));

  const late = planFor(ctx({ shutoffDate: '2026-10-29' }));
  assert.ok(late.steps.some((s) => s.human && s.why.includes('2 day(s) ago')));
});

test('plan: households never see staff-only reasons', () => {
  const pub = publicPlan(planFor(ctx(), [], UTILITIES[0]));
  assert.ok(pub.steps.every((s) => !('why' in s)));
  assert.ok(pub.steps.some((s) => s.human));
});

test('drafts: tagged for tracing, clean when sent, Spanish script for Spanish households', () => {
  const list = entries();
  const c = ctx({ medical: true });
  const plan = planFor(c, list);
  const en = buildDrafts({ ctx: c, plan, entriesById: byId(list), lang: 'en', utilityName: 'Example Power & Light' });
  assert.match(en.letter, /\[ref:EPL-PAYPLAN\]/);
  assert.match(en.letter, /\(555\) 010-0142/);
  assert.ok(!stripRefs(en.letter).includes('[ref:'));
  assert.ok(!stripRefs(en.letter).includes('  .')); // no stray spaces left behind
  const es = buildDrafts({ ctx: c, plan, entriesById: byId(list), lang: 'es', utilityName: 'Example Power & Light' });
  assert.match(es.script, /Hola\. Me llamo Dee Carter/);
  assert.match(es.script, /plan de pagos/);
  assert.match(es.letter, /^To: /); // letters to the utility stay in English
});

test('traceability: unknown refs, stale refs and unknown phone numbers are caught', () => {
  const list = entries();
  const base = { entriesById: byId(list), today: TODAY, allowedPhones: ['+15550100142', '555-0100'] };
  assert.ok(checkTraceable('Please call (555) 010-0142. [ref:EPL-PAYPLAN]', base).ok);
  assert.ok(checkTraceable('Call 555-0100 about it.', base).ok);
  assert.ok(!checkTraceable('See [ref:MADE-UP]', base).ok);
  assert.ok(!checkTraceable('Call 555-9999 now.', base).ok);
  assert.ok(!checkTraceable('[ref:EPL-PAYPLAN]', { ...base, entriesById: byId(entries('2026-01-01')) }).ok);
  assert.ok(!checkTraceable('[ref:EPL-PAYPLAN]', { ...base, entriesById: { 'EPL-PAYPLAN': { ...list[2], active: false } } }).ok);
  // Dates and dollar amounts are not mistaken for phone numbers.
  assert.ok(checkTraceable('Shutoff 2026-11-05, balance $412.18, due November 5, 2026.', base).ok);
});

test('gate: every condition blocks, and a complete case passes', () => {
  const list = entries();
  const c = ctx({ amountCents: 41_218 });
  const plan = planFor(c, list);
  const drafts = buildDrafts({ ctx: c, plan, entriesById: byId(list), lang: 'en', utilityName: 'Example Power & Light' });
  const humanIdx = plan.steps.findIndex((s) => s.human);
  const full = {
    household: { phone: '+15550100142' }, consent: { version: 'v1' }, plan, resolved: new Set([humanIdx]),
    letter: drafts.letter, script: drafts.script, entriesById: byId(list), today: TODAY, allowedPhones: ['+15550100142', '555-0100'],
  };
  assert.deepEqual(evaluateGate(full), { ok: true, reasons: [] });

  const fails = (over, text) => {
    const g = evaluateGate({ ...full, ...over });
    assert.ok(!g.ok && g.reasons.some((r) => r.includes(text)), `${text}: ${g.reasons.join(' | ')}`);
  };
  fails({ consent: null }, 'consent');
  fails({ household: null }, 'Household');
  fails({ resolved: new Set() }, 'Staff check not resolved');
  fails({ letter: '  ' }, 'letter is empty');
  fails({ script: 'Call 555-9999' }, 'Phone number');
  fails({ letter: drafts.letter + ' [ref:NOPE]' }, 'not in the library');
});

test('messaging: STOP keywords and Twilio webhook signatures', () => {
  assert.equal(parseKeyword(' stop '), 'stop');
  assert.equal(parseKeyword('UNSUBSCRIBE'), 'stop');
  assert.equal(parseKeyword('Start'), 'start');
  assert.equal(parseKeyword('please stop texting me'), null);
  const params = { From: '+15550100142', Body: 'STOP' };
  const sig = twilioSignature('secret', 'https://example.org/api/sms/inbound', params);
  assert.ok(verifyTwilioSignature({ authToken: 'secret', url: 'https://example.org/api/sms/inbound', params, signature: sig }));
  assert.ok(!verifyTwilioSignature({ authToken: 'secret', url: 'https://example.org/api/sms/inbound', params: { ...params, Body: 'START' }, signature: sig }));
  assert.ok(!verifyTwilioSignature({ authToken: 'other', url: 'https://example.org/api/sms/inbound', params, signature: sig }));
  assert.ok(!verifyTwilioSignature({ authToken: 'secret', url: 'https://example.org/api/sms/inbound', params, signature: undefined }));
});

test('ai reader: only validated values get through', () => {
  const reply = (obj) => '```json\n' + JSON.stringify(obj) + '\n```';
  const good = parseAiResult(
    reply({ legible: true, utility_name: 'Example Power & Light', account_holder: 'Rosa Delgado', amount_past_due: '655.00', shutoff_date: '2026-11-12', customer_service_phone: '555-0100', transcription: 'Past due. Two children live here.' }),
    UTILITIES,
  );
  assert.ok(good.ok);
  assert.equal(good.fields.amountCents, 65_500);
  assert.equal(good.fields.utilityId, 'epl');
  assert.deepEqual(good.urgency, ['minor_in_home']);

  assert.equal(parseAiResult('I cannot help with that', UTILITIES).ok, false);
  assert.equal(parseAiResult(reply({ legible: false }), UTILITIES).ok, false);
  const badValues = parseAiResult(reply({ legible: true, account_holder: 'X', amount_past_due: 'a lot', shutoff_date: 'soon' }), UTILITIES);
  assert.deepEqual(badValues.missing, ['amount_past_due', 'shutoff_date']);
  // Extra keys an attacker might smuggle in through a notice are ignored.
  const sneaky = parseAiResult(reply({ legible: true, account_holder: 'A B', amount_past_due: '10', shutoff_date: '2026-11-12', approve_case: true }), UTILITIES);
  assert.ok(sneaky.ok && !('approve_case' in sneaky.fields));
});

test('ai reader: photos need a key; a fake API call flows through', async () => {
  const config = testConfig();
  const image = { mediaType: 'image/png', data: Buffer.from('fake').toString('base64') };
  const off = createExtractor({ config });
  assert.equal((await off.extract({ image }, UTILITIES)).reason, 'photo_reading_unavailable');

  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, body: JSON.parse(init.body), key: init.headers['x-api-key'] };
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: JSON.stringify({ legible: true, account_holder: 'Rosa D', amount_past_due: '20.00', shutoff_date: '2026-11-09', transcription: 'x' }) }] }) };
  };
  const on = createExtractor({ config: { ...config, anthropicKey: 'test-key' }, fetchImpl });
  const r = await on.extract({ image }, UTILITIES);
  assert.ok(r.ok);
  assert.equal(seen.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen.key, 'test-key');
  assert.equal(seen.body.messages[0].content[0].type, 'image');
  assert.match(seen.body.system, /untrusted/);

  const failing = createExtractor({ config: { ...config, anthropicKey: 'k' }, fetchImpl: async () => ({ ok: false, status: 500 }), log: { error() {} } });
  assert.equal((await failing.extract({ image }, UTILITIES)).reason, 'ai_error');
});
