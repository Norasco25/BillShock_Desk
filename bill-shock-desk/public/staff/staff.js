// The staff console: queue, case review with the approval gate, library, results.
// Every write sends x-bsd-csrf so a form on another website cannot act as the signed-in person.

import { h, mount, request, money, dateLabel } from '/lib/dom.js';

const root = document.getElementById('app');
const state = { tab: 'queue', cases: [], current: null, library: null, report: null, error: '', note: '', busy: false, me: '' };
const api = (method, url, body) => request(method, url, body, { 'x-bsd-csrf': '1' });

async function run(fn) {
  state.busy = true; state.error = ''; state.note = ''; render();
  try { await fn(); } catch (err) {
    state.error = err.message;
    if (err.data?.reasons) state.error += ': ' + err.data.reasons.join('; ');
  } finally { state.busy = false; render(); }
}

const go = (tab, load) => run(async () => { state.tab = tab; state.current = null; await load?.(); });
const loadQueue = async () => { state.cases = (await api('GET', '/api/staff/cases')).cases; };
const loadLibrary = async () => { state.library = await api('GET', '/api/staff/library'); };
const loadReport = async () => { state.report = await api('GET', '/api/staff/report'); };
const openCase = (id) => run(async () => { state.tab = 'case'; state.current = await api('GET', `/api/staff/cases/${id}`); });
const update = (call) => run(async () => { state.current = await call(); });

const btn = (text, onclick, kind = 'primary') => h('button', { type: 'button', class: `btn ${kind}`, onclick, disabled: state.busy }, text);
const pill = (text, kind = '') => h('span', { class: `pill ${kind}` }, text);
const label = (text, input) => h('label', { class: 'field' }, h('span', { class: 'label' }, text), input);

// ---------- layout ----------

function nav() {
  const tab = (id, text, load) => h('button', { type: 'button', class: `btn secondary tab`, 'aria-current': state.tab === id ? 'page' : null, onclick: () => go(id, load) }, text);
  return h('div', {},
    h('header', { class: 'top' }, h('div', {}, h('h1', {}, 'Bill Shock Desk · Staff'), h('p', { class: 'tagline' }, state.me ? `Signed in as ${state.me}` : ''))),
    h('nav', { class: 'tabs' }, tab('queue', 'Queue', loadQueue), tab('library', 'Library', loadLibrary), tab('report', 'Results', loadReport)),
    state.error ? h('p', { class: 'error', role: 'alert' }, state.error) : null,
    state.note ? h('p', { class: 'notice', role: 'status' }, state.note) : null);
}

// ---------- queue ----------

function queueView() {
  if (!state.cases.length) return h('p', { class: 'card' }, 'No cases are waiting. Cases appear here after a household sends them.');
  return h('table', {},
    h('thead', {}, h('tr', {}, ['Case', 'Name', 'Past due', 'Shutoff', 'Status', 'Flags'].map((c) => h('th', {}, c)))),
    h('tbody', {}, state.cases.map((c) => h('tr', { class: 'click', tabIndex: 0, onclick: () => openCase(c.id), onkeydown: (e) => { if (e.key === 'Enter') openCase(c.id); } },
      h('td', { class: 'mono' }, c.displayId), h('td', {}, c.holder), h('td', {}, money(c.amountCents)),
      h('td', {}, `${dateLabel(c.shutoffDate)} `, pill(c.daysLeft < 0 ? 'past' : `${c.daysLeft}d`, c.daysLeft <= 3 ? 'urgent' : '')),
      h('td', {}, c.status),
      h('td', {}, c.urgency.map((u) => pill(u.replace(/_/g, ' '), 'urgent')), c.openChecks ? pill(`${c.openChecks} to check`, 'bad') : null)))));
}

// ---------- case ----------

function gateBox(d) {
  return h('div', { class: `gate ${d.gate.ok ? 'open' : 'blocked'}` },
    h('strong', {}, d.gate.ok ? 'Ready: the approval gate is open.' : 'Blocked: fix these before approving or sending.'),
    d.gate.ok ? null : h('ul', {}, d.gate.reasons.map((r) => h('li', {}, r))));
}

function planView(d) {
  const editable = ['in_review', 'approved', 'rejected'].includes(d.status);
  return h('div', { class: 'card' }, h('h2', {}, 'Plan'),
    h('ol', { class: 'steps' }, d.plan.steps.map((s) => h('li', { class: `step ${s.kind}` },
      h('h3', {}, s.title.en, ' ', s.kind !== 'entry' ? pill(s.kind) : pill(s.entryKind), s.human ? pill(s.resolved ? 'checked' : 'needs check', s.resolved ? 'ok' : 'bad') : null),
      h('p', {}, s.body.en),
      s.why ? h('p', { class: 'why' }, `Why: ${s.why}`) : null,
      s.sourceUrl ? h('p', { class: 'small' }, h('a', { href: s.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Source'), ` · verified ${s.verifiedOn}`) : null,
      s.human && editable ? btn(s.resolved ? 'Re-open check' : 'Mark as checked', () => update(() => api('PUT', `/api/staff/cases/${d.id}/checks/${s.index}`, { resolved: !s.resolved })), 'secondary') : null))),
    editable ? btn('Rebuild plan from library', () => update(() => api('POST', `/api/staff/cases/${d.id}/regenerate`)), 'secondary') : null);
}

function draftsView(d) {
  const editable = ['in_review', 'approved', 'rejected'].includes(d.status);
  const letter = h('textarea', { class: 'draft', id: 'letter', value: d.letter ?? '', disabled: !editable });
  const script = h('textarea', { class: 'draft', id: 'script', value: d.script ?? '', disabled: !editable });
  const sendable = ['approved', 'sent'].includes(d.status);
  return h('div', { class: 'card stack' }, h('h2', {}, 'Drafts'),
    h('p', { class: 'small why' }, 'Every sentence carries a [ref:ID] tag that points at a library entry. The tags are removed when sending. Editing after approval removes the approval.'),
    label('Letter to the utility', letter), label('Phone script for the household', script),
    h('div', { class: 'row' },
      editable ? btn('Save drafts', () => update(() => api('PUT', `/api/staff/cases/${d.id}/drafts`, { letter: letter.value, script: script.value }))) : null,
      d.status === 'in_review' ? btn('Approve', () => update(() => api('POST', `/api/staff/cases/${d.id}/approve`))) : null,
      editable && d.status !== 'rejected' ? btn('Reject…', () => { const reason = prompt('Why are you rejecting this case?'); if (reason) update(() => api('POST', `/api/staff/cases/${d.id}/reject`, { reason })); }, 'secondary') : null,
      sendable ? btn('Send script by text', () => update(() => api('POST', `/api/staff/cases/${d.id}/send`, { what: 'script' })), 'secondary') : null,
      sendable ? btn('Send letter', () => update(() => api('POST', `/api/staff/cases/${d.id}/send`, { what: 'letter' })), 'secondary') : null),
    d.outbound.length ? h('table', {}, h('thead', {}, h('tr', {}, ['When', 'To', 'Kind', 'Status'].map((c) => h('th', {}, c)))),
      h('tbody', {}, d.outbound.map((m) => h('tr', {}, h('td', { class: 'small' }, m.createdAt?.slice(0, 16).replace('T', ' ')), h('td', {}, m.audience), h('td', {}, m.kind), h('td', {}, m.status))))) : null);
}

function workView(d) {
  const kind = h('select', {}, ['call', 'message', 'filing', 'note'].map((k) => h('option', { value: k }, k)));
  const minutes = h('input', { type: 'number', min: 0, max: 600, value: 10 });
  const text = h('textarea', { rows: 2 });
  const type = h('select', {}, [['plan_confirmed', 'Payment plan confirmed'], ['extension', 'Extension granted'], ['assistance_applied', 'Assistance applied'], ['shutoff_happened', 'Shutoff happened'], ['no_response', 'No response']].map(([v, l]) => h('option', { value: v }, l)));
  const dollars = h('input', { type: 'text', inputMode: 'decimal', placeholder: 'Dollars saved or covered' });
  const open = d.status !== 'closed';
  return h('div', { class: 'card stack' }, h('h2', {}, 'Work log and outcome'),
    d.actions.length ? h('ul', {}, d.actions.map((a) => h('li', {}, `${a.kind} · ${a.minutes} min · ${a.actor}: ${a.text}`))) : h('p', { class: 'hint' }, 'Nothing logged yet.'),
    open ? h('div', { class: 'stack' }, label('Kind', kind), label('Minutes', minutes), label('What happened', text),
      btn('Add to log', () => update(() => api('POST', `/api/staff/cases/${d.id}/log`, { kind: kind.value, minutes: Number(minutes.value), text: text.value }))),
      h('hr'), d.outcome ? h('p', {}, `Outcome: ${d.outcome.type}${d.outcome.dollarsCents ? ' · ' + money(d.outcome.dollarsCents) : ''}`) : null,
      label('Outcome', type), label('Dollars', dollars),
      h('div', { class: 'row' },
        btn('Record outcome', () => update(() => api('POST', `/api/staff/cases/${d.id}/outcome`, { type: type.value, dollars: dollars.value || undefined }))),
        btn('Close case and delete notice', () => { if (confirm('Closing deletes the stored notice. Continue?')) update(() => api('POST', `/api/staff/cases/${d.id}/close`)); }, 'secondary'))) : null);
}

function caseView() {
  const d = state.current;
  return h('div', { class: 'stack' },
    h('div', { class: 'row' }, btn('← Queue', () => go('queue', loadQueue), 'secondary')),
    h('h2', {}, `${d.displayId} · ${d.holder}`, ' ', pill(d.status), d.urgency.map((u) => pill(u.replace(/_/g, ' '), 'urgent'))),
    h('p', {}, `${money(d.amountCents)} past due · shutoff ${dateLabel(d.shutoffDate)} (${d.daysLeft} days) · ${d.utility?.name ?? `No rules for "${d.utilityNameOnNotice ?? 'unknown utility'}"`} · language ${d.language}`),
    gateBox(d),
    h('div', { class: 'cols' },
      h('div', { class: 'stack' },
        h('div', { class: 'card' }, h('h2', {}, 'Household'),
          d.household ? h('p', {}, `${d.household.size} people · income ${d.household.income} · ${[d.household.medical && 'medical', d.household.minor && 'child', d.household.senior && 'senior'].filter(Boolean).join(', ') || 'no flags'}`,
            h('br'), `Phone ${d.household.phone || '—'} · texts ${d.household.smsStoppedAt ? 'STOPPED' : d.household.smsOptIn ? 'opted in' : 'not opted in'}`) : null,
          d.consent ? h('p', { class: 'small why' }, `Consent ${d.consent.version} given ${d.consent.givenAt?.slice(0, 10)}.`) : h('p', { class: 'error' }, 'No consent recorded.')),
        h('div', { class: 'card' }, h('h2', {}, 'Original notice'),
          d.notice.text ? h('pre', { class: 'notice-text' }, d.notice.text) : h('p', { class: 'hint' }, d.notice.deletedAt ? 'The notice was deleted.' : 'No text stored.'),
          d.notice.hasImage ? h('a', { href: `/api/staff/cases/${d.id}/notice-image`, target: '_blank', rel: 'noopener' }, 'Open photo') : null),
        workView(d)),
      h('div', { class: 'stack' }, d.plan ? planView(d) : null, draftsView(d))));
}

// ---------- library ----------

const ENTRY_FIELDS = [['id', 'ID'], ['utilityId', 'Utility ID'], ['kind', 'Kind (protection, payment_plan, assistance_fund, discount, other)'], ['rank', 'Rank (lower shows first)'], ['titleEn', 'Title (English)'], ['titleEs', 'Title (Spanish)'], ['phone', 'Phone'], ['sourceUrl', 'Source URL (https)'], ['verifiedOn', 'Verified on (YYYY-MM-DD)'], ['verifiedBy', 'Verified by'], ['ttlDays', 'Days until it needs re-checking']];
const ENTRY_TEXT = [['bodyEn', 'Body (English)'], ['bodyEs', 'Body (Spanish)'], ['askLetter', 'Sentence for the letter'], ['askScriptEn', 'Phone script (English)'], ['askScriptEs', 'Phone script (Spanish)']];

function entryEditor(e) {
  const inputs = {};
  const rows = ENTRY_FIELDS.map(([k, l]) => { inputs[k] = h('input', { type: 'text', value: e[k] ?? '' }); return label(l, inputs[k]); });
  const texts = ENTRY_TEXT.map(([k, l]) => { inputs[k] = h('textarea', { rows: 2, value: e[k] ?? '' }); return h('div', { class: 'wide' }, label(l, inputs[k])); });
  inputs.documents = h('input', { type: 'text', value: (e.documents ?? []).join('; ') });
  inputs.when = h('input', { type: 'text', value: JSON.stringify(e.when ?? {}) });
  const collect = () => {
    const out = { active: true };
    for (const [k] of [...ENTRY_FIELDS, ...ENTRY_TEXT]) out[k] = inputs[k].value;
    out.rank = Number(out.rank); out.ttlDays = Number(out.ttlDays);
    out.documents = inputs.documents.value.split(';').map((s) => s.trim()).filter(Boolean);
    out.when = JSON.parse(inputs.when.value || '{}');
    return out;
  };
  return h('details', { class: 'card' },
    h('summary', {}, `${e.id} · ${e.titleEn} `, pill(e.fresh ? `fresh until ${e.expiresOn}` : 'out of date', e.fresh ? 'ok' : 'bad'), e.active ? null : pill('retired')),
    h('div', { class: 'entry-form' }, rows, texts, h('div', { class: 'wide' }, label('Documents to bring (separate with ;)', inputs.documents)), h('div', { class: 'wide' }, label('Applies when (JSON, empty {} means always)', inputs.when))),
    h('div', { class: 'row' },
      btn('Save', () => run(async () => { await api('PUT', `/api/staff/library/entries/${encodeURIComponent(e.id)}`, collect()); await loadLibrary(); state.note = `${e.id} saved.`; })),
      btn('Mark verified today', () => run(async () => {
        const entry = collect(); entry.verifiedOn = new Date().toISOString().slice(0, 10); entry.verifiedBy = state.me;
        await api('PUT', `/api/staff/library/entries/${encodeURIComponent(e.id)}`, entry); await loadLibrary(); state.note = `${e.id} marked verified.`;
      }), 'secondary'),
      e.active ? btn('Retire', () => { if (confirm(`Retire ${e.id}?`)) run(async () => { await api('DELETE', `/api/staff/library/entries/${encodeURIComponent(e.id)}`); await loadLibrary(); }); }, 'secondary') : null));
}

function libraryView() {
  const lib = state.library;
  if (!lib) return null;
  return h('div', { class: 'stack' },
    h('p', { class: 'notice' }, 'Only verified entries reach households. An entry past its re-check date is hidden from plans until a person confirms it against the source and saves it again.'),
    h('h2', {}, 'Utilities'),
    h('ul', {}, lib.utilities.map((u) => h('li', {}, `${u.id}: ${u.name} (${u.state})`))),
    h('h2', {}, 'Entries'), lib.entries.map(entryEditor));
}

// ---------- results ----------

function reportView() {
  const r = state.report;
  if (!r) return null;
  const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
  const stat = (v, l) => h('div', { class: 'stat' }, h('b', {}, v), l);
  return h('div', { class: 'stack' },
    h('div', {}, stat(r.cases, 'cases'), stat(r.open, 'open'), stat(pct(r.goodOutcomeRate), 'good outcome'), stat(r.avgDaysToResult ?? '—', 'avg days to result'), stat(r.avgStaffMinutes ?? '—', 'avg staff minutes'), stat(money(r.dollarsCents), 'dollars saved or covered')),
    h('table', {}, h('thead', {}, h('tr', {}, ['Case', 'Status', 'Outcome', 'Dollars', 'Minutes', 'Days'].map((c) => h('th', {}, c)))),
      h('tbody', {}, r.rows.map((x) => h('tr', {}, h('td', { class: 'mono' }, x.displayId), h('td', {}, x.status), h('td', {}, x.outcome ?? '—'), h('td', {}, x.dollarsCents == null ? '—' : money(x.dollarsCents)), h('td', {}, x.minutes), h('td', {}, x.daysToResult ?? '—'))))));
}

function render() {
  const body = state.tab === 'case' && state.current ? caseView() : state.tab === 'library' ? libraryView() : state.tab === 'report' ? reportView() : queueView();
  mount(root, nav(), body);
}

go('queue', async () => { state.me = (await api('GET', '/api/staff/me')).name; await loadQueue(); });
