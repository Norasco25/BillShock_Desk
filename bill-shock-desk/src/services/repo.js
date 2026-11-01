import { hashToken } from '../lib/crypto.js';
import { fromHousehold, mergeFlags } from '../domain/urgency.js';

// Everything that reads or writes library and case rows lives here, so the
// SQL is in one place and the rest of the code works with plain objects.

export const displayId = (id) => `C${String(id).padStart(4, '0')}`;
const parse = (s, fallback) => (s ? JSON.parse(s) : fallback);

// ---------- utilities and library ----------

const utilityFromRow = (r) => ({ id: r.id, name: r.name, state: r.state, patterns: parse(r.patterns, []) });

export const listUtilities = (db) => db.prepare('SELECT * FROM utilities ORDER BY name').all().map(utilityFromRow);

export function getUtility(db, id) {
  const r = db.prepare('SELECT * FROM utilities WHERE id = ?').get(id);
  return r ? utilityFromRow(r) : null;
}

export function upsertUtility(db, u) {
  db.prepare(
    `INSERT INTO utilities (id, name, state, patterns) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, state = excluded.state, patterns = excluded.patterns`,
  ).run(u.id, u.name, u.state, JSON.stringify(u.patterns));
}

export const entryFromRow = (r) => ({
  id: r.id,
  utilityId: r.utility_id,
  kind: r.kind,
  rank: r.rank,
  titleEn: r.title_en,
  titleEs: r.title_es,
  bodyEn: r.body_en,
  bodyEs: r.body_es,
  phone: r.phone,
  documents: parse(r.documents_json, []),
  when: parse(r.when_json, {}),
  askLetter: r.ask_letter,
  askScriptEn: r.ask_script_en,
  askScriptEs: r.ask_script_es,
  sourceUrl: r.source_url,
  verifiedOn: r.verified_on,
  verifiedBy: r.verified_by,
  ttlDays: r.ttl_days,
  active: r.active === 1,
});

export function listEntries(db, { utilityId, activeOnly = false } = {}) {
  const where = [];
  const args = [];
  if (utilityId) { where.push('utility_id = ?'); args.push(utilityId); }
  if (activeOnly) where.push('active = 1');
  const sql = `SELECT * FROM library_entries ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY utility_id, rank, id`;
  return db.prepare(sql).all(...args).map(entryFromRow);
}

/** Every entry, active or not, keyed by id. The gate uses this to spot references to retired entries. */
export function entriesById(db) {
  return Object.fromEntries(listEntries(db).map((e) => [e.id, e]));
}

export function upsertEntry(db, e) {
  db.prepare(
    `INSERT INTO library_entries
       (id, utility_id, kind, rank, title_en, title_es, body_en, body_es, phone, documents_json, when_json,
        ask_letter, ask_script_en, ask_script_es, source_url, verified_on, verified_by, ttl_days, active)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       utility_id=excluded.utility_id, kind=excluded.kind, rank=excluded.rank,
       title_en=excluded.title_en, title_es=excluded.title_es, body_en=excluded.body_en, body_es=excluded.body_es,
       phone=excluded.phone, documents_json=excluded.documents_json, when_json=excluded.when_json,
       ask_letter=excluded.ask_letter, ask_script_en=excluded.ask_script_en, ask_script_es=excluded.ask_script_es,
       source_url=excluded.source_url, verified_on=excluded.verified_on, verified_by=excluded.verified_by,
       ttl_days=excluded.ttl_days, active=excluded.active`,
  ).run(
    e.id, e.utilityId, e.kind, e.rank, e.titleEn, e.titleEs, e.bodyEn, e.bodyEs, e.phone,
    JSON.stringify(e.documents), JSON.stringify(e.when), e.askLetter, e.askScriptEn, e.askScriptEs,
    e.sourceUrl, e.verifiedOn, e.verifiedBy, e.ttlDays, e.active ? 1 : 0,
  );
}

// ---------- cases ----------

export function findCaseIdByToken(db, token, nowIso) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const row = db.prepare('SELECT id, token_expires_at FROM cases WHERE token_hash = ?').get(hashToken(token));
  if (!row || row.token_expires_at < nowIso) return null;
  return row.id;
}

/** Loads one case with everything attached to it, in plain objects. */
export function loadCase(db, id) {
  const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(id);
  if (!c) return null;

  const h = db.prepare('SELECT * FROM households WHERE case_id = ?').get(id);
  const household = h && {
    size: h.size,
    income: h.income,
    medical: h.medical === 1,
    minor: h.minor === 1,
    senior: h.senior === 1,
    phone: h.phone,
    smsOptIn: h.sms_opt_in === 1,
    smsStoppedAt: h.sms_stopped_at,
  };

  const consentRow = db.prepare('SELECT * FROM consents WHERE case_id = ?').get(id);
  const consent = consentRow && {
    version: consentRow.version,
    text: consentRow.text,
    scope: consentRow.scope,
    givenAt: consentRow.given_at,
  };

  const n = db
    .prepare(
      `SELECT media_type, deleted_at, text_enc IS NOT NULL AS has_text, image_enc IS NOT NULL AS has_image
       FROM notices WHERE case_id = ?`,
    )
    .get(id);

  const actions = db
    .prepare('SELECT id, kind, minutes, text, actor, created_at FROM actions WHERE case_id = ? ORDER BY id')
    .all(id)
    .map((a) => ({ id: a.id, kind: a.kind, minutes: a.minutes, text: a.text, actor: a.actor, createdAt: a.created_at }));

  const o = db.prepare('SELECT * FROM outcomes WHERE case_id = ?').get(id);

  return {
    id: c.id,
    displayId: displayId(c.id),
    status: c.status,
    language: c.language,
    utilityId: c.utility_id,
    utilityNameOnNotice: c.utility_name_on_notice,
    holder: c.holder,
    amountCents: c.amount_cents,
    shutoffDate: c.shutoff_date,
    noticePhone: c.notice_phone,
    noticeFlags: parse(c.notice_flags, []),
    urgency: mergeFlags(parse(c.notice_flags, []), fromHousehold(household)),
    plan: parse(c.plan_json, null),
    letter: c.letter,
    script: c.script,
    approvedAt: c.approved_at,
    approvedBy: c.approved_by,
    createdAt: c.created_at,
    submittedAt: c.submitted_at,
    closedAt: c.closed_at,
    piiPurgedAt: c.pii_purged_at,
    household,
    consent,
    notice: {
      hasText: Boolean(n?.has_text),
      hasImage: Boolean(n?.has_image),
      mediaType: n?.media_type ?? null,
      deletedAt: n?.deleted_at ?? null,
    },
    resolved: new Set(db.prepare('SELECT step_idx FROM staff_checks WHERE case_id = ?').all(id).map((r) => r.step_idx)),
    actions,
    minutes: actions.reduce((sum, a) => sum + a.minutes, 0),
    outcome: o && { type: o.type, dollarsCents: o.dollars_cents, recordedAt: o.recorded_at, recordedBy: o.recorded_by },
    outbound: db
      .prepare(
        `SELECT id, channel, audience, kind, status, error, created_at AS createdAt, sent_at AS sentAt
         FROM outbound_messages WHERE case_id = ? ORDER BY id`,
      )
      .all(id)
      .map((m) => ({ ...m })),
  };
}

/** The facts the plan and the drafts are built from. Needs the household to exist. */
export function planContext(agg) {
  const h = agg.household;
  return {
    holder: agg.holder,
    amountCents: agg.amountCents,
    shutoffDate: agg.shutoffDate,
    utilityNameOnNotice: agg.utilityNameOnNotice,
    noticePhone: agg.noticePhone,
    size: h.size,
    income: h.income,
    medical: h.medical,
    minor: h.minor,
    senior: h.senior,
    phone: h.phone,
  };
}

export function audit(db, now, actor, event, caseId = null) {
  db.prepare('INSERT INTO audit_log (case_id, actor, event, at) VALUES (?, ?, ?, ?)').run(caseId, actor, event, now);
}

/** Editing anything staff approved sends the case back to review. */
export function clearApproval(db, caseId) {
  db.prepare(
    `UPDATE cases
     SET approved_at = NULL, approved_by = NULL,
         status = CASE WHEN status IN ('approved','sent','rejected') THEN 'in_review' ELSE status END
     WHERE id = ? AND status <> 'closed' AND status <> 'draft'`,
  ).run(caseId);
}
