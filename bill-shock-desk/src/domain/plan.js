import { daysBetween, formatDate } from '../lib/dates.js';
import { formatCents } from '../lib/money.js';
import { evaluateWhen, isFresh } from './library.js';

/**
 * Builds the household's action plan.
 *
 * The plan never invents anything. Each step is one of:
 *   deadline  the shutoff date, from the notice
 *   entry     a library entry that applies and is up to date
 *   stale     an entry that would apply but is out of date: needs a staff check
 *   gap       something we cannot answer from the library: needs a staff check
 *
 * Steps with `human: true` must be resolved by a staff member before the case
 * can be approved (see domain/gate.js).
 *
 * @param {object} args
 * @param {object} args.ctx      notice facts + household answers
 * @param {object|null} args.utility
 * @param {object[]} args.entries  active library entries for this utility
 * @param {string} args.today     YYYY-MM-DD in the service area's time zone
 */
export function buildPlan({ ctx, utility, entries, today, largeBalanceCents }) {
  const steps = [];
  const left = daysBetween(today, ctx.shutoffDate);

  steps.push(deadlineStep(ctx.shutoffDate, left));
  if (left < 0) {
    steps.push(
      gap({
        en: ['Staff check: shutoff date has passed', 'The date on your notice has passed. A staff member will contact you today.'],
        es: ['Revisión del personal: la fecha de corte ya pasó', 'La fecha de su aviso ya pasó. Una persona del equipo se comunicará con usted hoy.'],
        why: `Shutoff date ${ctx.shutoffDate} is ${-left} day(s) ago. Check whether service was already cut.`,
      }),
    );
  }

  if (!utility) {
    steps.push(
      gap({
        en: ['Staff check: utility not recognized', 'We do not have rules for this utility yet. A staff member will look at your case and contact you.'],
        es: ['Revisión del personal: compañía no reconocida', 'Todavía no tenemos reglas para esta compañía. Una persona del equipo revisará su caso y se comunicará con usted.'],
        why: `Utility "${ctx.utilityNameOnNotice ?? 'unknown'}" is not in the library.`,
      }),
    );
    return finish(steps, today);
  }

  const ordered = [...entries].sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  for (const e of ordered) {
    if (!evaluateWhen(e.when, ctx)) continue;
    if (isFresh(e, today)) {
      steps.push({
        kind: 'entry',
        entryId: e.id,
        entryKind: e.kind,
        title: { en: e.titleEn, es: e.titleEs },
        body: { en: e.bodyEn, es: e.bodyEs },
        documents: e.documents,
        phone: e.phone,
        sourceUrl: e.sourceUrl,
        verifiedOn: e.verifiedOn,
        human: false,
      });
    } else {
      steps.push({
        kind: 'stale',
        entryId: e.id,
        title: { en: `Staff check: ${e.titleEn}`, es: `Revisión del personal: ${e.titleEs}` },
        body: {
          en: 'A program may apply to you. A staff member will confirm the details before we tell you more.',
          es: 'Es posible que un programa le aplique. Una persona del equipo confirmará los detalles antes de darle más información.',
        },
        human: true,
        why: `Library entry ${e.id} was last verified ${e.verifiedOn} and is out of date. Re-check ${e.sourceUrl} and update the entry.`,
      });
    }
  }

  if (!ordered.some((e) => e.kind === 'payment_plan' && e.active)) {
    steps.push(
      gap({
        en: ['Staff check: payment plan', 'A staff member will confirm your payment plan options.'],
        es: ['Revisión del personal: plan de pagos', 'Una persona del equipo confirmará sus opciones de plan de pagos.'],
        why: `The library has no active payment plan entry for ${utility.name}.`,
      }),
    );
  }

  if (ctx.amountCents > largeBalanceCents) {
    steps.push(
      gap({
        en: ['Staff check: large balance', 'Your balance is large. A staff member will look for other help that is not in our list yet.'],
        es: ['Revisión del personal: saldo grande', 'Su saldo es grande. Una persona del equipo buscará otra ayuda que todavía no está en nuestra lista.'],
        why: `Balance ${formatCents(ctx.amountCents)} is over ${formatCents(largeBalanceCents)}. No library entry covers reducing it.`,
      }),
    );
  }

  return finish(steps, today);
}

function deadlineStep(shutoffDate, left) {
  const days = (n, lang) => (lang === 'es' ? `${n} día${n === 1 ? '' : 's'}` : `${n} day${n === 1 ? '' : 's'}`);
  const en =
    left < 0
      ? `Your notice gave a shutoff date of ${formatDate(shutoffDate, 'en')}. That date has passed.`
      : left === 0
        ? `Your notice says your service can be shut off today, ${formatDate(shutoffDate, 'en')}. Start with the first step below.`
        : `Your notice says your service can be shut off on ${formatDate(shutoffDate, 'en')}. You have ${days(left, 'en')} left. Start with the first step below.`;
  const es =
    left < 0
      ? `Su aviso daba una fecha de corte del ${formatDate(shutoffDate, 'es')}. Esa fecha ya pasó.`
      : left === 0
        ? `Su aviso dice que pueden cortar su servicio hoy, ${formatDate(shutoffDate, 'es')}. Empiece con el primer paso de abajo.`
        : `Su aviso dice que pueden cortar su servicio el ${formatDate(shutoffDate, 'es')}. Le quedan ${days(left, 'es')}. Empiece con el primer paso de abajo.`;
  return {
    kind: 'deadline',
    daysLeft: left,
    title: { en: 'Shutoff date', es: 'Fecha de corte' },
    body: { en, es },
    human: false,
  };
}

function gap({ en, es, why }) {
  return {
    kind: 'gap',
    title: { en: en[0], es: es[0] },
    body: { en: en[1], es: es[1] },
    human: true,
    why,
  };
}

function finish(steps, today) {
  return { steps, needsStaff: steps.some((s) => s.human), builtOn: today };
}

/** What the household may see: staff-only reasons are removed. */
export function publicPlan(plan) {
  if (!plan) return null;
  return {
    needsStaff: plan.needsStaff,
    steps: plan.steps.map(({ why, ...rest }) => rest), // eslint-disable-line no-unused-vars
  };
}
