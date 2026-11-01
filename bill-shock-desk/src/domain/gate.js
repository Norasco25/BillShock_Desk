import { checkTraceable } from './traceability.js';

/**
 * The approval gate. A case can be approved, and anything can be sent, only
 * when this returns ok. It is a pure function so it is easy to test, and the
 * database enforces the most important parts again (see src/db.js).
 */
export function evaluateGate({ household, consent, plan, resolved, letter, script, entriesById, today, allowedPhones }) {
  const reasons = [];

  if (!household) reasons.push('Household details are missing.');
  if (!consent) reasons.push('No recorded consent from the household.');

  if (!plan) {
    reasons.push('No plan has been built.');
  } else {
    plan.steps.forEach((step, i) => {
      if (step.human && !resolved.has(i)) reasons.push(`Staff check not resolved: ${step.title.en}.`);
    });
  }

  for (const [name, body] of [['letter', letter], ['script', script]]) {
    if (!body || !body.trim()) {
      reasons.push(`The ${name} is empty.`);
      continue;
    }
    const check = checkTraceable(body, { entriesById, today, allowedPhones });
    for (const p of check.problems) reasons.push(`Draft ${name}: ${p}`);
  }

  return { ok: reasons.length === 0, reasons };
}
