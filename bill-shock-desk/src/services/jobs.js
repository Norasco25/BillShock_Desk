import { daysBetween, plusDaysIso, todayIn } from '../lib/dates.js';
import { tx } from '../db.js';
import { audit } from './repo.js';
import { sendOutbound } from './messaging.js';

// ===== Retention =====
// Personal data is kept only as long as it is needed.

/** Deletes the stored notice (text and photo). Keeps the fact that it existed. */
export function purgeNotice(db, caseId, nowIso) {
  db.prepare('UPDATE notices SET text_enc = NULL, image_enc = NULL, deleted_at = ? WHERE case_id = ? AND deleted_at IS NULL').run(nowIso, caseId);
}

/** Removes names, phone numbers and free text. Keeps counts, minutes, outcomes and dollars for reporting. */
export function scrubPii(db, caseId, nowIso) {
  tx(db, () => {
    db.prepare(
      `UPDATE cases SET holder = '[removed]', notice_phone = NULL, letter = NULL, script = NULL, pii_purged_at = ? WHERE id = ?`,
    ).run(nowIso, caseId);
    db.prepare(`UPDATE households SET phone = '', sms_opt_in = 0 WHERE case_id = ?`).run(caseId);
    db.prepare(`UPDATE actions SET text = '[removed]' WHERE case_id = ?`).run(caseId);
    db.prepare(`UPDATE outbound_messages SET body = '[removed]' WHERE case_id = ?`).run(caseId);
  });
}

export function runRetention({ db, config, clock }) {
  const now = clock.now();
  const nowIso = now.toISOString();
  let draftsDeleted = 0;
  let noticesPurged = 0;
  let piiScrubbed = 0;

  // Intakes nobody finished.
  const cutoff = plusDaysIso(now, -config.draftTtlHours / 24);
  const stale = db.prepare(`SELECT id FROM cases WHERE status = 'draft' AND created_at < ?`).all(cutoff);
  for (const { id } of stale) {
    tx(db, () => {
      db.prepare('DELETE FROM cases WHERE id = ?').run(id); // notices, household, consent go with it (ON DELETE CASCADE)
      audit(db, nowIso, 'system', 'draft_deleted', id);
    });
    draftsDeleted += 1;
  }

  // Closed cases past their notice retention.
  for (const { id } of db
    .prepare(
      `SELECT c.id FROM cases c JOIN notices n ON n.case_id = c.id
       WHERE c.status = 'closed' AND c.notice_purge_at <= ? AND n.deleted_at IS NULL`,
    )
    .all(nowIso)) {
    purgeNotice(db, id, nowIso);
    audit(db, nowIso, 'system', 'notice_purged', id);
    noticesPurged += 1;
  }

  // Closed cases past their personal-data retention.
  for (const { id } of db
    .prepare(`SELECT id FROM cases WHERE status = 'closed' AND pii_purge_at <= ? AND pii_purged_at IS NULL`)
    .all(nowIso)) {
    scrubPii(db, id, nowIso);
    audit(db, nowIso, 'system', 'pii_scrubbed', id);
    piiScrubbed += 1;
  }

  return { draftsDeleted, noticesPurged, piiScrubbed };
}

// ===== Reminders =====

const REMINDER_TEXT = {
  en: (n) => `Bill Shock Desk reminder: your shutoff date is ${n === 0 ? 'today' : `in ${n} day${n === 1 ? '' : 's'}`}. Follow the steps in your plan. Reply STOP to stop texts.`,
  es: (n) => `Recordatorio de Bill Shock Desk: su fecha de corte es ${n === 0 ? 'hoy' : `en ${n} día${n === 1 ? '' : 's'}`}. Siga los pasos de su plan. Responda STOP para no recibir más textos.`,
};

/**
 * Texts the household (and alerts staff) at set days before the shutoff.
 * Safe to run as often as you like: each (case, day, audience) is sent once.
 * Only approved cases get reminders, because the database refuses to send for others.
 */
export async function runReminders({ db, config, clock, messenger }) {
  const today = todayIn(config.timezone, clock.now());
  const nowIso = clock.now().toISOString();
  let household = 0;
  let staff = 0;

  const rows = db
    .prepare(
      `SELECT c.id, c.shutoff_date, c.language, h.phone, h.sms_opt_in, h.sms_stopped_at
       FROM cases c JOIN households h ON h.case_id = c.id
       WHERE c.status IN ('approved','sent')`,
    )
    .all();

  const alreadySent = db.prepare('SELECT 1 FROM reminders_sent WHERE case_id = ? AND offset_days = ? AND audience = ?');
  const markSent = db.prepare('INSERT INTO reminders_sent (case_id, offset_days, audience, sent_at) VALUES (?, ?, ?, ?)');

  for (const r of rows) {
    const daysLeft = daysBetween(today, r.shutoff_date);
    if (!config.reminderOffsets.includes(daysLeft)) continue;

    if (r.sms_opt_in === 1 && !r.sms_stopped_at && !alreadySent.get(r.id, daysLeft, 'household')) {
      try {
        const text = (REMINDER_TEXT[r.language] ?? REMINDER_TEXT.en)(daysLeft);
        await sendOutbound({ db, messenger, clock }, { caseId: r.id, channel: 'sms', audience: 'household', kind: 'reminder', body: text, to: r.phone });
        markSent.run(r.id, daysLeft, 'household', nowIso);
        household += 1;
      } catch (err) {
        console.error(`[reminders] case ${r.id}: ${err.message}`); // retried on the next run
      }
    }

    if (config.staffAlertPhone && !alreadySent.get(r.id, daysLeft, 'staff')) {
      try {
        const body = `Bill Shock Desk: case ${r.id} shutoff is ${daysLeft === 0 ? 'today' : `in ${daysLeft} day(s)`}. Open the staff console.`;
        await sendOutbound({ db, messenger, clock }, { caseId: r.id, channel: 'sms', audience: 'staff', kind: 'alert', body, to: config.staffAlertPhone });
        markSent.run(r.id, daysLeft, 'staff', nowIso);
        staff += 1;
      } catch (err) {
        console.error(`[reminders] staff alert for case ${r.id}: ${err.message}`);
      }
    }
  }
  return { household, staff };
}

/** Runs both jobs now and every 15 minutes. The timer does not keep the process alive. */
export function startJobs(deps) {
  const tick = async () => {
    try {
      runRetention(deps);
      await runReminders(deps);
    } catch (err) {
      console.error(`[jobs] ${err.message}`);
    }
  };
  tick();
  const timer = setInterval(tick, 15 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
