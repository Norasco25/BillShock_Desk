import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { runReminders, runRetention } from '../src/services/jobs.js';
import { twilioSignature } from '../src/services/messaging.js';
import { household, notice, startApp, submitCase } from './helpers.js';

const urlencode = (o) => new URLSearchParams(o).toString();

test('a household goes from notice to closed case, and every safety rule holds on the way', async (t) => {
  const s = await startApp();
  t.after(() => s.close());

  // ---- household ----
  const cfg = await s.api('GET', '/api/config');
  assert.equal(cfg.status, 200);
  assert.equal(cfg.body.utilities[0].id, 'epl');
  assert.match(cfg.body.consent.text.en, /Nothing is sent until a staff member/);

  const started = await s.api('POST', '/api/cases', { language: 'en', text: notice() });
  assert.equal(started.status, 201);
  const { token, view } = started.body;
  assert.equal(view.fields.holder, 'Dee Carter');
  assert.equal(view.fields.amount, '412.18');
  assert.equal(view.fields.utilityId, 'epl');
  assert.equal(view.status, 'draft');
  assert.equal(view.urgent, false);
  assert.equal(view.plan, null);

  const fixed = await s.api('PUT', `/api/cases/${token}/fields`, { holder: 'Dee Carter', amount: '412.18', shutoffDate: '2026-11-05', utilityId: 'epl' });
  assert.equal(fixed.status, 200);

  const missingConsent = await s.api('PUT', `/api/cases/${token}/household`, household({ consent: false }));
  assert.equal(missingConsent.status, 400);
  const badPhone = await s.api('PUT', `/api/cases/${token}/household`, household({ phone: '123' }));
  assert.equal(badPhone.status, 400);

  const saved = await s.api('PUT', `/api/cases/${token}/household`, household());
  assert.equal(saved.status, 200);
  const steps = saved.body.plan.steps;
  assert.equal(steps[0].kind, 'deadline');
  assert.ok(steps.some((x) => x.entryId === 'EPL-PAYPLAN'));
  assert.ok(steps.some((x) => x.entryId === 'EPL-FUND'));
  assert.ok(steps.some((x) => x.human), 'a $412 balance needs a staff check');
  assert.ok(steps.every((x) => !('why' in x)), 'households never see staff-only reasons');

  // A draft is invisible to staff until the household submits it.
  assert.equal((await s.staff('GET', '/api/staff/cases')).body.cases.length, 0);
  assert.equal((await s.api('POST', `/api/cases/${token}/submit`)).body.status, 'in_review');
  assert.equal((await s.api('PUT', `/api/cases/${token}/fields`, { holder: 'X', amount: '1', shutoffDate: '2026-11-05' })).status, 409, 'no edits after submitting');

  // ---- staff sign-in and CSRF ----
  assert.equal((await s.api('GET', '/api/staff/cases')).status, 401);
  assert.equal((await s.api('GET', '/api/staff/cases', undefined, { authorization: s.basic('maria', 'nope') })).status, 401);
  const noCsrf = await s.api('POST', '/api/staff/cases/1/approve', {}, { authorization: s.basic('maria', 'pw-one') });
  assert.equal(noCsrf.status, 403);

  const queue = (await s.staff('GET', '/api/staff/cases')).body.cases;
  assert.equal(queue.length, 1);
  assert.equal(queue[0].openChecks, 1);
  const id = queue[0].id;

  // ---- the gate ----
  let detail = (await s.staff('GET', `/api/staff/cases/${id}`)).body;
  assert.equal(detail.gate.ok, false);
  assert.ok(detail.gate.reasons.some((r) => r.includes('Staff check not resolved')));
  assert.match(detail.notice.text, /Account holder: Dee Carter/);
  assert.ok(detail.letter.includes('[ref:EPL-PAYPLAN]'));

  const early = await s.staff('POST', `/api/staff/cases/${id}/approve`);
  assert.equal(early.status, 409);
  assert.ok(early.body.reasons.length > 0);
  const tooSoon = await s.staff('POST', `/api/staff/cases/${id}/send`, { what: 'script' });
  assert.equal(tooSoon.status, 409);
  assert.equal(s.app.messenger.outbox.length, 0, 'nothing was sent');

  const gapIdx = detail.plan.steps.find((x) => x.human).index;
  assert.equal((await s.staff('PUT', `/api/staff/cases/${id}/checks/0`, { resolved: true })).status, 400, 'only flagged steps can be marked');
  assert.equal((await s.staff('PUT', `/api/staff/cases/${id}/checks/${gapIdx}`, { resolved: true })).status, 200);
  const approved = await s.staff('POST', `/api/staff/cases/${id}/approve`);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, 'approved');
  assert.equal(approved.body.approvedBy, 'maria');

  // ---- editing after approval removes approval ----
  const edited = await s.staff('PUT', `/api/staff/cases/${id}/drafts`, { letter: detail.letter + '\nCall me at 555-999-0000.', script: detail.script });
  assert.equal(edited.body.status, 'in_review');
  assert.equal(edited.body.approvedAt, null);
  assert.ok(edited.body.gate.reasons.some((r) => r.includes('Phone number')));
  assert.equal((await s.staff('POST', `/api/staff/cases/${id}/send`, { what: 'letter' })).status, 409);
  assert.equal((await s.staff('POST', `/api/staff/cases/${id}/approve`)).status, 409);

  await s.staff('PUT', `/api/staff/cases/${id}/drafts`, { letter: detail.letter, script: detail.script });
  assert.equal((await s.staff('POST', `/api/staff/cases/${id}/approve`)).status, 200);

  // ---- sending ----
  const sentScript = await s.staff('POST', `/api/staff/cases/${id}/send`, { what: 'script' });
  assert.equal(sentScript.status, 200);
  assert.equal(sentScript.body.status, 'sent');
  assert.equal(s.app.messenger.outbox.length, 1);
  assert.ok(!s.app.messenger.outbox[0].body.includes('[ref:'), 'tags are stripped before sending');
  assert.equal(s.app.messenger.outbox[0].to, '+15550100142');
  const sentLetter = await s.staff('POST', `/api/staff/cases/${id}/send`, { what: 'letter' });
  assert.equal(sentLetter.body.outbound.filter((m) => m.status === 'sent').length, 2);

  // ---- reminders: once each, only before the deadline, never after STOP ----
  s.setNow('2026-11-02T15:00:00Z'); // 3 days before
  assert.deepEqual(await runReminders(s.jobDeps()), { household: 1, staff: 0 });
  assert.deepEqual(await runReminders(s.jobDeps()), { household: 0, staff: 0 }, 'not sent twice');
  assert.match(s.app.messenger.outbox.at(-1).body, /in 3 days/);

  const stopRes = await fetch(`${s.base}/api/sms/inbound`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: urlencode({ From: '+15550100142', Body: 'STOP' }),
  });
  assert.equal(stopRes.status, 200);
  assert.match(await stopRes.text(), /<Response>/);

  s.setNow('2026-11-04T15:00:00Z'); // 1 day before
  const before = s.app.messenger.outbox.length;
  assert.deepEqual(await runReminders(s.jobDeps()), { household: 0, staff: 0 });
  assert.equal(s.app.messenger.outbox.length, before, 'no text after STOP');
  const afterStop = await s.staff('POST', `/api/staff/cases/${id}/send`, { what: 'script' });
  assert.equal(afterStop.status, 409, 'the database refuses texts after STOP');
  assert.match(afterStop.body.error, /opted out/);

  // ---- work log, outcome, close ----
  assert.equal((await s.staff('POST', `/api/staff/cases/${id}/close`)).status, 409, 'needs an outcome first');
  const logged = await s.staff('POST', `/api/staff/cases/${id}/log`, { kind: 'call', minutes: 45, text: 'Customer Care set up 3 payments.' });
  assert.equal(logged.body.minutes, 45);
  assert.equal((await s.staff('POST', `/api/staff/cases/${id}/log`, { kind: 'call', minutes: -5, text: 'x' })).status, 400);
  const outcome = await s.staff('POST', `/api/staff/cases/${id}/outcome`, { type: 'plan_confirmed', dollars: '412.18' });
  assert.equal(outcome.body.outcome.dollarsCents, 41_218);

  const closed = await s.staff('POST', `/api/staff/cases/${id}/close`);
  assert.equal(closed.body.status, 'closed');
  assert.equal(closed.body.notice.text, null, 'the notice is deleted when the case closes');
  assert.equal(closed.body.notice.deletedAt !== null, true);
  assert.equal((await s.staff('POST', `/api/staff/cases/${id}/send`, { what: 'script' })).status, 409);
  assert.equal((await s.staff('PUT', `/api/staff/cases/${id}/drafts`, { letter: 'x', script: 'y' })).status, 409);

  const report = (await s.staff('GET', '/api/staff/report')).body;
  assert.equal(report.cases, 1);
  assert.equal(report.goodOutcomeRate, 1);
  assert.equal(report.dollarsCents, 41_218);
  assert.equal(report.avgStaffMinutes, 45);

  // ---- personal data is scrubbed after the retention period, aggregates stay ----
  s.setNow('2026-12-10T15:00:00Z');
  const ran = runRetention(s.jobDeps());
  assert.equal(ran.piiScrubbed, 1);
  const scrubbed = (await s.staff('GET', `/api/staff/cases/${id}`)).body;
  assert.equal(scrubbed.holder, '[removed]');
  assert.equal(scrubbed.household.phone, '');
  assert.equal(scrubbed.letter, null);
  assert.equal(scrubbed.actions[0].text, '[removed]');
  assert.equal(scrubbed.actions[0].minutes, 45);
  assert.equal((await s.staff('GET', '/api/staff/report')).body.dollarsCents, 41_218);

  // ---- the audit trail names who did what ----
  const events = s.db.prepare('SELECT actor, event FROM audit_log ORDER BY id').all().map((r) => `${r.actor}:${r.event}`);
  for (const e of ['household:consent_recorded', 'household:submitted', 'maria:approved', 'maria:sent_script', 'maria:closed', 'system:pii_scrubbed', 'household:sms_stop']) {
    assert.ok(events.includes(e), `missing audit event ${e}`);
  }
});

test('urgent cases jump the queue; unreadable notices are asked to retake', async (t) => {
  const s = await startApp();
  t.after(() => s.close());

  await submitCase(s, { text: notice({ holder: 'Early Bird', date: 'November 20, 2026' }) });
  const medical = await submitCase(s, {
    text: notice({ holder: 'Marcus Webb', date: 'November 30, 2026', extra: 'An oxygen concentrator (medical equipment) is used here.' }),
    hh: household({ medical: true }),
  });
  const queue = (await s.staff('GET', '/api/staff/cases')).body.cases;
  assert.equal(queue[0].holder, 'Marcus Webb', 'urgent first even with a later date');
  assert.deepEqual(queue[0].urgency, ['medical_equipment']);
  const d = (await s.staff('GET', `/api/staff/cases/${medical.id}`)).body;
  assert.ok(d.plan.steps.some((x) => x.entryId === 'EPL-MEDCERT'));

  const blurry = await s.api('POST', '/api/cases', { text: 'Acc0unt h**der: ?\nAm0u?t p?st d?e: $6?5.??' });
  assert.equal(blurry.status, 422);
  assert.equal(blurry.body.retake, true);
  assert.deepEqual(blurry.body.missing, ['account_holder', 'amount_past_due', 'shutoff_date']);

  const photo = await s.api('POST', '/api/cases', { image: { mediaType: 'image/png', data: Buffer.from('x').toString('base64') } });
  assert.equal(photo.status, 422);
  assert.equal(photo.body.reason, 'photo_reading_unavailable');
  assert.equal((await s.api('POST', '/api/cases', { image: { mediaType: 'application/pdf', data: 'AAAA' } })).status, 400);
  assert.equal((await s.api('POST', '/api/cases', {})).status, 400);
});

test('a notice from a utility we have no rules for goes to staff, not into a guess', async (t) => {
  const s = await startApp();
  t.after(() => s.close());
  const text = 'Acme Gas Co\nCustomer name: Sam Lee\nPast due amount: $90.00\nShutoff date: 11/09/2026';
  const { id } = await submitCase(s, { text });
  const d = (await s.staff('GET', `/api/staff/cases/${id}`)).body;
  assert.equal(d.utility, null);
  assert.deepEqual(d.plan.steps.map((x) => x.kind), ['deadline', 'gap']);
  assert.equal((await s.staff('POST', `/api/staff/cases/${id}/approve`)).status, 409);
});

test('library changes: an out-of-date entry blocks plans until a person re-verifies it', async (t) => {
  const s = await startApp();
  t.after(() => s.close());

  const lib = (await s.staff('GET', '/api/staff/library')).body;
  const fund = lib.entries.find((e) => e.id === 'EPL-FUND');
  assert.equal(fund.fresh, true);

  s.setNow('2027-03-15T15:00:00Z'); // past every entry's window
  const aged = (await s.staff('GET', '/api/staff/library')).body;
  assert.ok(aged.entries.every((e) => e.fresh === false));
  const { id } = await submitCase(s, { text: notice({ date: 'March 25, 2027', amount: '100.00' }) });
  let d = (await s.staff('GET', `/api/staff/cases/${id}`)).body;
  assert.ok(d.plan.steps.every((x) => x.kind !== 'entry'), 'no stale rule is shown as fact');
  assert.ok(d.plan.steps.some((x) => x.kind === 'stale'));

  // Staff re-verify the entries, then regenerate.
  const ids = lib.entries.map((e) => e.id);
  for (const e of aged.entries) {
    const { fresh, expiresOn, ...entry } = e; // eslint-disable-line no-unused-vars
    const res = await s.staff('PUT', `/api/staff/library/entries/${e.id}`, { ...entry, verifiedOn: '2027-03-15', verifiedBy: 'maria' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }
  assert.equal(ids.length, 5);
  d = (await s.staff('POST', `/api/staff/cases/${id}/regenerate`)).body;
  assert.ok(d.plan.steps.some((x) => x.kind === 'entry' && x.entryId === 'EPL-PAYPLAN'));

  // Bad edits are refused with reasons.
  const bad = await s.staff('PUT', '/api/staff/library/entries/EPL-FUND', { id: 'EPL-FUND', utilityId: 'epl', kind: 'x', sourceUrl: 'http://no' });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.reasons.length > 3);

  // A retired entry stops appearing.
  assert.equal((await s.staff('DELETE', '/api/staff/library/entries/EPL-FUND')).status, 200);
  d = (await s.staff('POST', `/api/staff/cases/${id}/regenerate`)).body;
  assert.ok(!d.plan.steps.some((x) => x.entryId === 'EPL-FUND'));
});

test('unfinished intakes are deleted, and links expire', async (t) => {
  const s = await startApp();
  t.after(() => s.close());
  const { body } = await s.api('POST', '/api/cases', { text: notice() });
  assert.equal((await s.api('GET', `/api/cases/${body.token}`)).status, 200);
  s.advanceHours(25);
  assert.equal(runRetention(s.jobDeps()).draftsDeleted, 1);
  assert.equal((await s.api('GET', `/api/cases/${body.token}`)).status, 404);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM notices').get().n, 0, 'the stored notice went with it');

  const done = await s.api('POST', '/api/cases', { text: notice() });
  s.advanceHours(24 * 31);
  assert.equal((await s.api('GET', `/api/cases/${done.body.token}`)).status, 404, 'tokens expire');
  assert.equal((await s.api('GET', '/api/cases/not-a-real-token-at-all-xx')).status, 404);
});

test('notices are encrypted at rest', async (t) => {
  const s = await startApp();
  t.after(() => s.close());
  await s.api('POST', '/api/cases', { text: notice({ holder: 'Plainly Visible' }) });
  const row = s.db.prepare('SELECT text_enc FROM notices').get();
  assert.ok(!Buffer.from(row.text_enc).includes('Plainly Visible'));
  assert.ok(!Buffer.from(row.text_enc).includes('Carter'));
  // The household token is stored only as a hash.
  const { body } = await s.api('POST', '/api/cases', { text: notice() });
  const hashes = s.db.prepare('SELECT token_hash FROM cases').all().map((r) => r.token_hash);
  assert.ok(!hashes.includes(body.token));
});

test('Spanish households get Spanish plans and scripts', async (t) => {
  const s = await startApp();
  t.after(() => s.close());
  const started = await s.api('POST', '/api/cases', { language: 'es', text: notice() });
  const saved = await s.api('PUT', `/api/cases/${started.body.token}/household`, household({ language: 'es' }));
  assert.match(saved.body.plan.steps[0].body.es, /Su aviso dice/);
  assert.equal(saved.body.language, 'es');
  const row = s.db.prepare('SELECT text FROM consents').get();
  assert.match(row.text, /Acepto que Bill Shock Desk/, 'the Spanish words are what is stored');
  await s.api('POST', `/api/cases/${started.body.token}/submit`);
  const script = s.db.prepare('SELECT script FROM cases').get().script;
  assert.match(script, /Hola\. Me llamo Dee Carter/);
});

test('the server: static files, path traversal, rate limits, bad input', async (t) => {
  const s = await startApp();
  t.after(() => s.close());

  // Traversal attempts are refused. Use a raw request so the client does not tidy the path.
  const raw = (path, headers = {}) =>
    new Promise((resolve, reject) => {
      const url = new URL(s.base);
      http.get({ host: url.hostname, port: url.port, path, headers }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }).on('error', reject);
    });
  assert.equal(await raw('/%2e%2e/%2e%2e/etc/passwd'), 404);
  assert.equal(await raw('/..%2f..%2fpackage.json'), 404);
  assert.equal(await raw('/staff/'), 401, 'staff files need a sign-in');
  assert.equal(await raw('/staff/', { authorization: s.basic('maria', 'pw-one') }) === 401, false);

  const plain = await fetch(`${s.base}/api/cases`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hello' });
  assert.equal(plain.status, 415);
  const res = await fetch(`${s.base}/api/cases`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
  assert.equal(res.status, 400);
  assert.equal((await s.api('DELETE', '/api/health')).status, 405);
  assert.equal((await s.api('GET', '/api/nothing-here')).status, 404);

  const big = await fetch(`${s.base}/api/cases`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(9 * 1024 * 1024) }) });
  assert.equal(big.status, 413);

  const health = await fetch(`${s.base}/api/health`);
  assert.match(health.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
});

test('rate limits: intake and staff password guessing', async (t) => {
  const s = await startApp();
  t.after(() => s.close());
  let last;
  for (let i = 0; i < 21; i += 1) last = await s.api('POST', '/api/cases', { text: 'nothing useful' });
  assert.equal(last.status, 429);
  assert.ok(last.headers.get('retry-after'));

  for (let i = 0; i < 10; i += 1) await s.api('GET', '/api/staff/cases', undefined, { authorization: s.basic('maria', `wrong${i}`) });
  const locked = await s.staff('GET', '/api/staff/cases'); // the right password, but too many failures first
  assert.equal(locked.status, 429);
});

test('inbound text webhook verifies Twilio signatures when configured', async (t) => {
  const s = await startApp({ env: { TWILIO_AUTH_TOKEN: 'shh', PUBLIC_BASE_URL: 'https://desk.example.org' } });
  t.after(() => s.close());
  const { token } = await submitCase(s).then((r) => r);
  const params = { From: '+15550100142', Body: 'STOP' };
  const post = (signature) =>
    fetch(`${s.base}/api/sms/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(signature ? { 'x-twilio-signature': signature } : {}) },
      body: urlencode(params),
    });
  assert.equal((await post()).status, 403);
  assert.equal((await post('forged')).status, 403);
  assert.equal(s.db.prepare('SELECT sms_stopped_at FROM households').get().sms_stopped_at, null);
  assert.equal((await post(twilioSignature('shh', 'https://desk.example.org/api/sms/inbound', params))).status, 200);
  assert.ok(s.db.prepare('SELECT sms_stopped_at FROM households').get().sms_stopped_at);
  assert.ok(token);
});
