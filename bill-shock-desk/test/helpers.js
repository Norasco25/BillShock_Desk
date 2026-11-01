import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { seedIfEmpty } from '../src/seed.js';

export const SEED_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'seed', 'library.json');

/** A notice in the labeled format the pattern reader understands. */
export const notice = ({ holder = 'Dee Carter', amount = '412.18', date = 'November 5, 2026', extra = '' } = {}) =>
  `EXAMPLE POWER & LIGHT
PAST DUE / DISCONNECTION NOTICE
Account holder: ${holder}
Amount past due: $${amount}
Disconnection date: ${date}
${extra}
Questions? Call Customer Care at 555-0100.`;

export const household = (over = {}) => ({
  size: 3,
  income: 'low',
  medical: false,
  minor: false,
  senior: false,
  phone: '555-010-0142',
  smsOptIn: true,
  consent: true,
  language: 'en',
  ...over,
});

export function testConfig(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsd-test-'));
  return loadConfig(
    {
      NODE_ENV: 'test',
      DATA_DIR: dir,
      NOTICE_KEY: crypto.randomBytes(32).toString('hex'),
      STAFF_USERS: 'maria:pw-one,james:pw-two',
      TIMEZONE: 'America/New_York',
      ...env,
    },
    { cwd: dir },
  );
}

/**
 * Starts the real app on a free port with an in-memory database, the example
 * library, and a clock the test can move. 2026-10-31 11:00 in New York.
 */
export async function startApp({ now = '2026-10-31T15:00:00Z', env = {}, extractor, messenger } = {}) {
  const config = testConfig(env);
  const db = openDb(':memory:');
  seedIfEmpty(db, { file: SEED_FILE, timezone: config.timezone, now: new Date(now) });

  const state = { t: new Date(now) };
  const clock = { now: () => new Date(state.t) };
  const deps = { config, db, clock };
  if (extractor) deps.extractor = extractor;
  if (messenger) deps.messenger = messenger;
  const app = createApp(deps);

  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
  const staffHeaders = { authorization: basic('maria', 'pw-one'), 'x-bsd-csrf': '1' };

  async function api(method, url, body, headers = {}) {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  }

  return {
    base, db, config, clock, app, api, basic,
    staff: (method, url, body) => api(method, url, body, staffHeaders),
    setNow: (iso) => { state.t = new Date(iso); },
    advanceHours: (h) => { state.t = new Date(state.t.getTime() + h * 3_600_000); },
    jobDeps: () => ({ db, config, clock, messenger: app.messenger }),
    async close() {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
      db.close();
    },
  };
}

/** Takes a notice through intake and submits it. Returns the token and case id. */
export async function submitCase(t, { text = notice(), hh = household() } = {}) {
  const started = await t.api('POST', '/api/cases', { language: hh.language, text });
  if (started.status !== 201) throw new Error(`intake failed: ${JSON.stringify(started.body)}`);
  const { token } = started.body;
  const saved = await t.api('PUT', `/api/cases/${token}/household`, hh);
  if (saved.status !== 200) throw new Error(`household failed: ${JSON.stringify(saved.body)}`);
  const sub = await t.api('POST', `/api/cases/${token}/submit`);
  if (sub.status !== 200) throw new Error(`submit failed: ${JSON.stringify(sub.body)}`);
  const list = await t.staff('GET', '/api/staff/cases');
  const id = Math.max(...list.body.cases.map((c) => c.id));
  return { token, id };
}
