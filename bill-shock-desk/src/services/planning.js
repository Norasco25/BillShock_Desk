import { todayIn } from '../lib/dates.js';
import { buildDrafts } from '../domain/drafts.js';
import { evaluateGate } from '../domain/gate.js';
import { buildPlan } from '../domain/plan.js';
import { entriesById, getUtility, listEntries, loadCase, planContext } from './repo.js';

/**
 * Builds (or rebuilds) a case's plan and drafts from the current library and
 * stores them. Rebuilding wipes staff check marks, because the steps may have
 * changed. Callers decide whether approval should be cleared too.
 */
export function rebuildPlan({ db, config, clock }, caseId) {
  const agg = loadCase(db, caseId);
  if (!agg || !agg.household) return null;

  const today = todayIn(config.timezone, clock.now());
  const utility = agg.utilityId ? getUtility(db, agg.utilityId) : null;
  const entries = utility ? listEntries(db, { utilityId: utility.id, activeOnly: true }) : [];
  const ctx = planContext(agg);

  const plan = buildPlan({ ctx, utility, entries, today, largeBalanceCents: config.largeBalanceCents });
  const byId = Object.fromEntries(entries.map((e) => [e.id, e]));
  const drafts = buildDrafts({
    ctx,
    plan,
    entriesById: byId,
    lang: agg.language,
    utilityName: utility?.name ?? agg.utilityNameOnNotice,
  });

  db.prepare('UPDATE cases SET plan_json = ?, letter = ?, script = ? WHERE id = ?').run(
    JSON.stringify(plan),
    drafts.letter,
    drafts.script,
    caseId,
  );
  db.prepare('DELETE FROM staff_checks WHERE case_id = ?').run(caseId);
  return plan;
}

/** Runs the approval gate against a loaded case using today's library. */
export function gateFor({ db, config, clock }, agg) {
  const today = todayIn(config.timezone, clock.now());
  const byId = entriesById(db);
  const allowedPhones = [
    agg.household?.phone,
    agg.noticePhone,
    ...Object.values(byId).filter((e) => e.utilityId === agg.utilityId).map((e) => e.phone),
  ].filter(Boolean);

  return evaluateGate({
    household: agg.household,
    consent: agg.consent,
    plan: agg.plan,
    resolved: agg.resolved,
    letter: agg.letter,
    script: agg.script,
    entriesById: byId,
    today,
    allowedPhones,
  });
}
