import { formatDate } from '../lib/dates.js';
import { formatCents } from '../lib/money.js';
import { formatPhone } from '../lib/phone.js';

// Drafts are built from fill-in-the-blank templates plus text staff wrote in
// the library. No free text is generated here. After every sentence that came
// from a library entry we leave a tag like [ref:EPL-PAYPLAN]. The gate uses the
// tags to prove each claim traces back to an entry, and `stripRefs` removes
// them before anything is sent.

const tag = (id) => `[ref:${id}]`;

export function stripRefs(text) {
  return String(text ?? '').replace(/[ \t]*\[ref:[A-Za-z0-9_-]+\]/g, '');
}

export function buildDrafts({ ctx, plan, entriesById, lang, utilityName }) {
  const used = plan.steps
    .filter((s) => s.kind === 'entry')
    .map((s) => entriesById[s.entryId])
    .filter(Boolean);

  const phone = formatPhone(ctx.phone);
  const amount = formatCents(ctx.amountCents);

  // --- letter to the utility (English) ---
  const letterAsks = used.filter((e) => e.askLetter).map((e) => `${e.askLetter} ${tag(e.id)}`);
  const letter = [
    `To: ${utilityName ?? 'Customer Care'}, Customer Care`,
    `Re: Request for help before shutoff on ${formatDate(ctx.shutoffDate, 'en')}`,
    '',
    'Dear Customer Care,',
    '',
    `My name is ${ctx.holder}. I received a past-due notice for ${amount}. The notice gives a shutoff date of ${formatDate(ctx.shutoffDate, 'en')}.`,
    '',
    ...(letterAsks.length ? letterAsks : ['I am asking for help so that my service is not shut off.']),
    '',
    `Please contact me at ${phone} or reply in writing.`,
    '',
    'Thank you,',
    ctx.holder,
  ].join('\n');

  // --- phone script for the household (their language) ---
  const es = lang === 'es';
  const pick = (e) => (es ? e.askScriptEs : e.askScriptEn);
  const scriptAsks = used.filter((e) => pick(e)).map((e) => `"${pick(e)}" ${tag(e.id)}`);
  const script = (es
    ? [
        `"Hola. Me llamo ${ctx.holder}. Tengo un aviso de atraso por ${amount} con fecha de corte el ${formatDate(ctx.shutoffDate, 'es')}."`,
        ...scriptAsks,
        '"¿Puede confirmar por escrito lo que acordamos?"',
        'Anote: la fecha, la hora, el nombre de la persona y lo que prometió.',
      ]
    : [
        `"Hello. My name is ${ctx.holder}. I have a past-due notice for ${amount} with a shutoff date of ${formatDate(ctx.shutoffDate, 'en')}."`,
        ...scriptAsks,
        '"Can you confirm what we agreed, and send it to me in writing?"',
        'Write down: the date, the time, the name of the person you spoke with, and what they promised.',
      ]
  ).join('\n\n');

  return { letter, script };
}
