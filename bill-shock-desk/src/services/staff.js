import { HttpError } from '../lib/errors.js';
import { decrypt } from '../lib/crypto.js';
import { daysBetween, plusDaysIso, todayIn } from '../lib/dates.js';
import { parseDollarsToCents } from '../lib/money.js';
import { asInt, asObject, asOneOf, asString } from '../lib/validate.js';
import { tx } from '../db.js';
import { stripRefs } from '../domain/drafts.js';
import { expiresOn, isFresh, validateEntry } from '../domain/library.js';
import { audit, clearApproval, getUtility, listEntries, listUtilities, loadCase, upsertEntry, upsertUtility } from './repo.js';
import { gateFor, rebuildPlan } from './planning.js';
import { sendOutbound } from './messaging.js';
import { purgeNotice } from './jobs.js';
import { readNoticeText } from './intake.js';

const OUTCOMES = ['plan_confirmed', 'extension', 'assistance_applied', 'shutoff_happened', 'no_response'];
const GOOD_OUTCOMES = ['plan_confirmed', 'extension', 'assistance_applied'];
const ACTION_KINDS = ['call', 'message', 'filing', 'note'];
const EDITABLE = ['in_review', 'approved', 'sent', 'rejected'];

export function createStaff({ db, config, clock, messenger }) {
  const nowIso = () => clock.now().toISOString();
  const today = () => todayIn(config.timezone, clock.now());
  const deps = { db, config, clock, messenger };

  function mustLoad(rawId) {
    const id = Number(rawId);
    const agg = Number.isInteger(id) ? loadCase(db, id) : null;
    if (!agg || agg.status === 'draft') throw new HttpError(404, 'Case not found.');
    return agg;
  }

  function mustBeEditable(agg) {
    if (!EDITABLE.includes(agg.status)) throw new HttpError(409, 'This case is closed.');
  }

  function summary(agg) {
    return {
      id: agg.id,
      displayId: agg.displayId,
      status: agg.status,
      holder: agg.holder,
      amountCents: agg.amountCents,
      shutoffDate: agg.shutoffDate,
      daysLeft: daysBetween(today(), agg.shutoffDate),
      urgency: agg.urgency,
      language: agg.language,
      minutes: agg.minutes,
      openChecks: agg.plan ? agg.plan.steps.filter((s, i) => s.human && !agg.resolved.has(i)).length : 0,
    };
  }

  // ----- queue -----

  /** Urgent first, then soonest shutoff. Closed cases sink to the bottom. */
  function list() {
    const ids = db.prepare(`SELECT id FROM cases WHERE status <> 'draft'`).all(); // one query per case is fine at this scale
    return ids
      .map(({ id }) => summary(loadCase(db, id)))
      .sort((a, b) => {
        const closed = (x) => (x.status === 'closed' ? 1 : 0);
        if (closed(a) !== closed(b)) return closed(a) - closed(b);
        const urgent = (x) => (x.urgency.length ? 0 : 1);
        if (urgent(a) !== urgent(b)) return urgent(a) - urgent(b);
        return a.shutoffDate.localeCompare(b.shutoffDate) || a.id - b.id;
      });
  }

  // ----- one case -----

  function viewedRecently(caseId, actor, event) {
    const since = plusDaysIso(clock.now(), -10 / 1440); // ten minutes
    return Boolean(
      db.prepare('SELECT 1 FROM audit_log WHERE case_id = ? AND actor = ? AND event = ? AND at > ?').get(caseId, actor, event, since),
    );
  }

  function detail(id, actor) {
    const agg = mustLoad(id);
    let noticeText = null;
    if (agg.notice.hasText) {
      noticeText = readNoticeText(db, config.noticeKey, agg.id);
      if (!viewedRecently(agg.id, actor, 'notice_viewed')) audit(db, nowIso(), actor, 'notice_viewed', agg.id);
    }
    const utility = agg.utilityId ? getUtility(db, agg.utilityId) : null;
    return {
      id: agg.id,
      displayId: agg.displayId,
      status: agg.status,
      language: agg.language,
      urgency: agg.urgency,
      utility: utility ? { id: utility.id, name: utility.name } : null,
      utilityNameOnNotice: agg.utilityNameOnNotice,
      holder: agg.holder,
      amountCents: agg.amountCents,
      shutoffDate: agg.shutoffDate,
      daysLeft: daysBetween(today(), agg.shutoffDate),
      household: agg.household,
      consent: agg.consent,
      plan: agg.plan && { ...agg.plan, steps: agg.plan.steps.map((s, i) => ({ ...s, index: i, resolved: agg.resolved.has(i) })) },
      letter: agg.letter,
      script: agg.script,
      gate: gateFor(deps, agg),
      actions: agg.actions,
      minutes: agg.minutes,
      outcome: agg.outcome,
      outbound: agg.outbound,
      approvedAt: agg.approvedAt,
      approvedBy: agg.approvedBy,
      notice: { ...agg.notice, text: noticeText },
    };
  }

  function noticeImage(id, actor) {
    const agg = mustLoad(id);
    const row = db.prepare('SELECT image_enc, media_type FROM notices WHERE case_id = ?').get(agg.id);
    if (!row?.image_enc) throw new HttpError(404, 'No notice photo is stored for this case.');
    if (!viewedRecently(agg.id, actor, 'notice_viewed')) audit(db, nowIso(), actor, 'notice_viewed', agg.id);
    return { mediaType: row.media_type, bytes: decrypt(config.noticeKey, row.image_enc) };
  }

  // ----- editing -----

  function saveDrafts(actor, id, input) {
    const agg = mustLoad(id);
    mustBeEditable(agg);
    const body = asObject(input);
    const letter = asString(body.letter, 'Letter', { max: 10_000, trim: false });
    const script = asString(body.script, 'Script', { max: 10_000, trim: false });
    tx(db, () => {
      db.prepare('UPDATE cases SET letter = ?, script = ? WHERE id = ?').run(letter, script, agg.id);
      clearApproval(db, agg.id);
      audit(db, nowIso(), actor, 'drafts_edited', agg.id);
    });
    return detail(id, actor);
  }

  function setCheck(actor, id, idx, input) {
    const agg = mustLoad(id);
    mustBeEditable(agg);
    const i = asInt(idx, 'Step', { min: 0, max: 100 });
    const step = agg.plan?.steps[i];
    if (!step?.human) throw new HttpError(400, 'That step does not need a staff check.');
    const resolved = asObject(input).resolved === true;
    tx(db, () => {
      if (resolved) {
        db.prepare('INSERT OR IGNORE INTO staff_checks (case_id, step_idx, resolved_by, resolved_at) VALUES (?, ?, ?, ?)').run(agg.id, i, actor, nowIso());
      } else {
        db.prepare('DELETE FROM staff_checks WHERE case_id = ? AND step_idx = ?').run(agg.id, i);
      }
      clearApproval(db, agg.id);
      audit(db, nowIso(), actor, resolved ? 'check_resolved' : 'check_reopened', agg.id);
    });
    return detail(id, actor);
  }

  /** Rebuild from the current library, for example after you fixed an out-of-date entry. */
  function regenerate(actor, id) {
    const agg = mustLoad(id);
    mustBeEditable(agg);
    tx(db, () => {
      rebuildPlan(deps, agg.id);
      clearApproval(db, agg.id);
      audit(db, nowIso(), actor, 'plan_regenerated', agg.id);
    });
    return detail(id, actor);
  }

  // ----- approval and sending -----

  function approve(actor, id) {
    const agg = mustLoad(id);
    if (agg.status !== 'in_review') throw new HttpError(409, `A case that is "${agg.status}" cannot be approved.`);
    const gate = gateFor(deps, agg);
    if (!gate.ok) throw new HttpError(409, 'The approval gate is blocking this case.', { reasons: gate.reasons });
    tx(db, () => {
      db.prepare(`UPDATE cases SET status = 'approved', approved_at = ?, approved_by = ? WHERE id = ?`).run(nowIso(), actor, agg.id);
      audit(db, nowIso(), actor, 'approved', agg.id);
    });
    return detail(id, actor);
  }

  function reject(actor, id, input) {
    const agg = mustLoad(id);
    mustBeEditable(agg);
    const reason = asString(asObject(input).reason, 'Reason', { min: 3, max: 500 });
    tx(db, () => {
      db.prepare(`UPDATE cases SET status = 'rejected', approved_at = NULL, approved_by = NULL WHERE id = ?`).run(agg.id);
      db.prepare(`INSERT INTO actions (case_id, kind, minutes, text, actor, created_at) VALUES (?, 'note', 0, ?, ?, ?)`).run(agg.id, `Rejected: ${reason}`, actor, nowIso());
      audit(db, nowIso(), actor, 'rejected', agg.id);
    });
    return detail(id, actor);
  }

  async function send(actor, id, input) {
    const what = asOneOf(asObject(input).what, 'what', ['letter', 'script']);
    const agg = mustLoad(id);
    if (!['approved', 'sent'].includes(agg.status)) throw new HttpError(409, 'Approve the case before sending.');

    // Check the gate again at the moment of sending: the library may have changed since approval.
    const gate = gateFor(deps, agg);
    if (!gate.ok) throw new HttpError(409, 'The approval gate is blocking this case.', { reasons: gate.reasons });

    if (what === 'letter') {
      await sendOutbound(deps, { caseId: agg.id, channel: 'letter', audience: 'utility', kind: 'letter', body: stripRefs(agg.letter) });
    } else {
      await sendOutbound(deps, { caseId: agg.id, channel: 'sms', audience: 'household', kind: 'script', body: stripRefs(agg.script), to: agg.household.phone });
    }
    db.prepare(`UPDATE cases SET status = 'sent' WHERE id = ? AND status = 'approved'`).run(agg.id);
    audit(db, nowIso(), actor, `sent_${what}`, agg.id);
    return detail(id, actor);
  }

  // ----- log, outcome, close -----

  function addAction(actor, id, input) {
    const agg = mustLoad(id);
    mustBeEditable(agg);
    const b = asObject(input);
    db.prepare('INSERT INTO actions (case_id, kind, minutes, text, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      agg.id,
      asOneOf(b.kind, 'kind', ACTION_KINDS),
      asInt(b.minutes ?? 0, 'Minutes', { min: 0, max: 1440 }),
      asString(b.text, 'What happened', { min: 1, max: 1000 }),
      actor,
      nowIso(),
    );
    return detail(id, actor);
  }

  function recordOutcome(actor, id, input) {
    const agg = mustLoad(id);
    mustBeEditable(agg);
    const b = asObject(input);
    const type = asOneOf(b.type, 'type', OUTCOMES);
    const cents = parseDollarsToCents(b.dollars ?? 0);
    if (cents === null || cents > 10_000_000) throw new HttpError(400, 'Dollars must be an amount between 0 and 100,000.');
    tx(db, () => {
      db.prepare(
        `INSERT INTO outcomes (case_id, type, dollars_cents, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(case_id) DO UPDATE SET type = excluded.type, dollars_cents = excluded.dollars_cents,
           recorded_by = excluded.recorded_by, recorded_at = excluded.recorded_at`,
      ).run(agg.id, type, cents, actor, nowIso());
      audit(db, nowIso(), actor, 'outcome_recorded', agg.id);
    });
    return detail(id, actor);
  }

  function close(actor, id) {
    const agg = mustLoad(id);
    mustBeEditable(agg);
    if (!agg.outcome) throw new HttpError(409, 'Record an outcome before closing the case.');
    const now = clock.now();
    tx(db, () => {
      db.prepare(
        `UPDATE cases SET status = 'closed', closed_at = ?, notice_purge_at = ?, pii_purge_at = ? WHERE id = ?`,
      ).run(
        now.toISOString(),
        plusDaysIso(now, config.noticeRetentionDays),
        plusDaysIso(now, config.piiRetentionDays),
        agg.id,
      );
      if (config.noticeRetentionDays === 0) purgeNotice(db, agg.id, now.toISOString());
      audit(db, now.toISOString(), actor, 'closed', agg.id);
    });
    return detail(id, actor);
  }

  // ----- library -----

  const decorate = (e) => ({ ...e, expiresOn: expiresOn(e), fresh: isFresh(e, today()) });

  function listLibrary() {
    return { utilities: listUtilities(db), entries: listEntries(db).map(decorate), today: today() };
  }

  function saveEntry(actor, input, { id: forcedId } = {}) {
    const raw = { ...asObject(input), ...(forcedId ? { id: forcedId } : {}) };
    const checked = validateEntry(raw, { today: today() });
    if (!checked.ok) throw new HttpError(400, 'The entry has problems.', { reasons: checked.errors });
    if (!getUtility(db, checked.value.utilityId)) throw new HttpError(400, 'The entry has problems.', { reasons: ['utilityId is not a known utility'] });
    tx(db, () => {
      upsertEntry(db, checked.value);
      audit(db, nowIso(), actor, `library_saved:${checked.value.id}`);
    });
    return decorate(checked.value);
  }

  function retireEntry(actor, id) {
    const found = listEntries(db).find((e) => e.id === id);
    if (!found) throw new HttpError(404, 'Entry not found.');
    tx(db, () => {
      db.prepare('UPDATE library_entries SET active = 0 WHERE id = ?').run(id);
      audit(db, nowIso(), actor, `library_retired:${id}`);
    });
    return { ok: true };
  }

  function saveUtility(actor, input, { id: forcedId } = {}) {
    const b = { ...asObject(input), ...(forcedId ? { id: forcedId } : {}) };
    const problems = [];
    if (!/^[a-z0-9_-]{2,40}$/.test(b.id ?? '')) problems.push('id must be 2 to 40 lowercase letters, numbers, dashes or underscores');
    if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 100) problems.push('name is required (up to 100 characters)');
    if (typeof b.state !== 'string' || !/^[A-Za-z]{2}$/.test(b.state)) problems.push('state must be a two-letter code');
    if (!Array.isArray(b.patterns) || b.patterns.length === 0 || b.patterns.length > 10) {
      problems.push('patterns must be a list of 1 to 10 expressions');
    } else {
      b.patterns.forEach((p, i) => {
        try {
          if (typeof p !== 'string' || p.length > 100) throw new Error();
          new RegExp(p, 'i'); // eslint-disable-line no-new
        } catch {
          problems.push(`patterns[${i}] is not a valid expression (up to 100 characters)`);
        }
      });
    }
    if (problems.length) throw new HttpError(400, 'The utility has problems.', { reasons: problems });
    const value = { id: b.id, name: b.name.trim(), state: b.state.toUpperCase(), patterns: b.patterns };
    tx(db, () => {
      upsertUtility(db, value);
      audit(db, nowIso(), actor, `utility_saved:${value.id}`);
    });
    return value;
  }

  // ----- results -----

  function report() {
    const aggs = db.prepare(`SELECT id FROM cases WHERE status <> 'draft'`).all().map(({ id }) => loadCase(db, id));
    const withOutcome = aggs.filter((a) => a.outcome);
    const good = withOutcome.filter((a) => GOOD_OUTCOMES.includes(a.outcome.type));
    const daysToResult = withOutcome
      .filter((a) => a.submittedAt)
      .map((a) => daysBetween(a.submittedAt.slice(0, 10), a.outcome.recordedAt.slice(0, 10)));
    const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

    const byOutcome = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
    withOutcome.forEach((a) => { byOutcome[a.outcome.type] += 1; });

    return {
      cases: aggs.length,
      open: aggs.filter((a) => a.status !== 'closed').length,
      withOutcome: withOutcome.length,
      goodOutcomeRate: withOutcome.length ? good.length / withOutcome.length : null,
      avgDaysToResult: avg(daysToResult),
      avgStaffMinutes: avg(aggs.map((a) => a.minutes)),
      dollarsCents: withOutcome.reduce((s, a) => s + a.outcome.dollarsCents, 0),
      byOutcome,
      rows: aggs.map((a) => ({
        displayId: a.displayId,
        status: a.status,
        outcome: a.outcome?.type ?? null,
        dollarsCents: a.outcome?.dollarsCents ?? null,
        minutes: a.minutes,
        daysToResult: a.outcome && a.submittedAt ? daysBetween(a.submittedAt.slice(0, 10), a.outcome.recordedAt.slice(0, 10)) : null,
      })),
    };
  }

  return {
    list, detail, noticeImage, saveDrafts, setCheck, regenerate, approve, reject, send,
    addAction, recordOutcome, close, listLibrary, saveEntry, retireEntry, saveUtility, report,
  };
}
