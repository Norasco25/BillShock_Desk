import assert from 'node:assert/strict';
import test from 'node:test';
import { openDb } from '../src/db.js';
import { seedIfEmpty } from '../src/seed.js';
import { listEntries, listUtilities } from '../src/services/repo.js';
import { isFresh } from '../src/domain/library.js';
import { SEED_FILE } from './helpers.js';

const NOW = '2026-10-31T15:00:00Z';

function freshDb() {
  const db = openDb(':memory:');
  db.prepare(
    `INSERT INTO cases (id, token_hash, token_expires_at, status, created_at) VALUES (1, 'h', '2099-01-01', 'in_review', ?)`,
  ).run(NOW);
  return db;
}
const send = (db, over = {}) => {
  const m = { channel: 'sms', audience: 'household', kind: 'script', ...over };
  return db
    .prepare(`INSERT INTO outbound_messages (case_id, channel, audience, kind, body, status, created_at) VALUES (1, ?, ?, ?, 'hi', 'queued', ?)`)
    .run(m.channel, m.audience, m.kind, NOW);
};
const addHousehold = (db, sms = 1) =>
  db.prepare(`INSERT INTO households (case_id, size, income, medical, minor, senior, phone, sms_opt_in) VALUES (1, 2, 'low', 0, 0, 0, '+15550100142', ?)`).run(sms);
const addConsent = (db) =>
  db.prepare(`INSERT INTO consents (case_id, version, text, scope, given_at) VALUES (1, 'v1', 'agreed', 'scope', ?)`).run(NOW);

test('seed loads the example library once, with fresh entries', () => {
  const db = openDb(':memory:');
  assert.equal(seedIfEmpty(db, { file: SEED_FILE, timezone: 'America/New_York', now: new Date(NOW) }), true);
  assert.equal(seedIfEmpty(db, { file: SEED_FILE, timezone: 'America/New_York', now: new Date(NOW) }), false);
  assert.equal(listUtilities(db).length, 1);
  const entries = listEntries(db);
  assert.equal(entries.length, 5);
  assert.ok(entries.every((e) => isFresh(e, '2026-10-31')));
  assert.ok(entries.every((e) => e.verifiedBy.includes('not verified')), 'example data says so');
});

test('database blocks sending until the case is approved', () => {
  const db = freshDb();
  addHousehold(db);
  addConsent(db);
  assert.throws(() => send(db), /send blocked: case is not approved/);
  db.prepare(`UPDATE cases SET status = 'approved', approved_at = ? WHERE id = 1`).run(NOW);
  assert.doesNotThrow(() => send(db));
});

test('database blocks sending without consent, and blocks approval without consent', () => {
  const db = freshDb();
  addHousehold(db);
  assert.throws(
    () => db.prepare(`UPDATE cases SET status = 'approved', approved_at = ? WHERE id = 1`).run(NOW),
    /approval blocked: no recorded consent/,
  );
  // Even if someone sets the approval flag some other way, sending still needs consent.
  db.prepare(`UPDATE cases SET status = 'approved' WHERE id = 1`).run();
  assert.throws(() => send(db), /not approved/);
});

test('database blocks texts to people who opted out, but staff alerts still go', () => {
  const db = freshDb();
  addHousehold(db, 1);
  addConsent(db);
  db.prepare(`UPDATE cases SET status = 'approved', approved_at = ? WHERE id = 1`).run(NOW);
  assert.doesNotThrow(() => send(db));
  db.prepare(`UPDATE households SET sms_stopped_at = ? WHERE case_id = 1`).run(NOW);
  assert.throws(() => send(db), /opted out/);
  assert.doesNotThrow(() => send(db, { audience: 'staff', kind: 'alert' }));
  assert.doesNotThrow(() => send(db, { channel: 'letter', audience: 'utility', kind: 'letter' })); // letters are not texts
});

test('texts to a household that never opted in are blocked', () => {
  const db = freshDb();
  addHousehold(db, 0);
  addConsent(db);
  db.prepare(`UPDATE cases SET status = 'approved', approved_at = ? WHERE id = 1`).run(NOW);
  assert.throws(() => send(db), /not opted in/);
});

test('audit log is append-only', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO audit_log (case_id, actor, event, at) VALUES (1, 'maria', 'approved', ?)`).run(NOW);
  assert.throws(() => db.prepare(`UPDATE audit_log SET actor = 'someone else'`).run(), /append-only/);
  assert.throws(() => db.prepare(`DELETE FROM audit_log`).run(), /append-only/);
  db.prepare('DELETE FROM cases WHERE id = 1').run(); // deleting the case...
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n, 1); // ...keeps its history
});

test('status values are constrained', () => {
  const db = freshDb();
  assert.throws(() => db.prepare(`UPDATE cases SET status = 'whatever' WHERE id = 1`).run());
});
