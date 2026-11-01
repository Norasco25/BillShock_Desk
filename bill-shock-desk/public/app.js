// The household side: read the notice, confirm it, describe the household,
// review the plan, send it to staff. State lives in this file's `state` object;
// the private case token lives in the URL fragment so it is never sent to a
// server in a Referer header or logged in a request line.

import { h, mount, request, dateLabel } from './lib/dom.js';
import { STRINGS } from './i18n.js';

const root = document.getElementById('app');
const state = {
  lang: localStorage.getItem('bsd-lang') || (navigator.language?.startsWith('es') ? 'es' : 'en'),
  config: null,
  token: null,
  view: null,
  screen: 'start', // start | check | about | plan | done
  busy: false,
  error: '',
  retake: null,
  photo: null,
};
const t = () => STRINGS[state.lang];

const tokenFromHash = () => new URLSearchParams(location.hash.slice(1)).get('c');
const setToken = (token) => { state.token = token; history.replaceState(null, '', token ? `#c=${token}` : location.pathname); };

async function guarded(fn) {
  state.busy = true; state.error = ''; render();
  try { await fn(); } catch (err) {
    if (err.status === 404 && state.token) { setToken(null); state.view = null; state.screen = 'start'; state.error = t().notFound; }
    else state.error = err.message || t().error;
  } finally { state.busy = false; render(); }
}

function setLang(lang) {
  state.lang = lang;
  localStorage.setItem('bsd-lang', lang);
  document.documentElement.lang = lang;
  render();
}

// ---------- pieces ----------

const field = (label, input, hint) => h('label', { class: 'field' }, h('span', { class: 'label' }, label), hint && h('span', { class: 'hint' }, hint), input);
const button = (text, onclick, kind = 'primary') => h('button', { type: 'button', class: `btn ${kind}`, onclick, disabled: state.busy }, text);

function header() {
  return h('header', { class: 'top' },
    h('div', {},
      h('h1', {}, t().title),
      h('p', { class: 'tagline' }, t().tagline)),
    h('button', { type: 'button', class: 'btn link', onclick: () => setLang(state.lang === 'en' ? 'es' : 'en'), lang: state.lang === 'en' ? 'es' : 'en' }, t().language));
}

const errorBox = () => (state.error ? h('p', { class: 'error', role: 'alert' }, state.error) : null);

// ---------- screens ----------

function startScreen() {
  const text = h('textarea', { id: 'notice-text', rows: 9, placeholder: 'Account holder: …\nAmount past due: $…\nShutoff date: …' });
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', disabled: !state.config?.photoReading, onchange: (e) => { state.photo = e.target.files[0] ?? null; } });
  const submit = () => guarded(async () => {
    const body = { language: state.lang };
    if (text.value.trim()) body.text = text.value;
    else if (state.photo) {
      const data = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1]);
        r.onerror = reject;
        r.readAsDataURL(state.photo);
      });
      body.image = { mediaType: state.photo.type, data };
    } else { state.error = t().pasteHint; return; }
    try {
      const res = await request('POST', '/api/cases', body);
      setToken(res.token); state.view = res.view; state.retake = null; state.screen = 'check';
    } catch (err) {
      if (err.status === 422) { state.retake = err.data; state.error = err.data.reason === 'photo_reading_unavailable' ? t().photoOff : t().retake; }
      else throw err;
    }
  });
  return h('section', { class: 'card' },
    field(t().pasteLabel, text, t().pasteHint),
    h('p', { class: 'or' }, t().or),
    field(t().photoLabel, file, state.config?.photoReading ? null : t().photoOff),
    state.retake?.missing?.length ? h('p', { class: 'hint' }, `${t().missing} ${state.retake.missing.map((k) => t().missingNames[k] ?? k).join(', ')}`) : null,
    button(state.busy ? t().reading : t().read, submit),
    h('p', { class: 'privacy' }, t().privacy));
}

function checkScreen() {
  const f = state.view.fields;
  const holder = h('input', { type: 'text', value: f.holder ?? '', autocomplete: 'off' });
  const amount = h('input', { type: 'text', inputMode: 'decimal', value: f.amount ?? '' });
  const date = h('input', { type: 'text', placeholder: 'YYYY-MM-DD', value: f.shutoffDate ?? '' });
  const utility = h('select', {},
    ...state.config.utilities.map((u) => h('option', { value: u.id, selected: u.id === f.utilityId }, u.name)),
    h('option', { value: '', selected: !f.utilityId }, t().utilityOther));
  const save = () => guarded(async () => {
    state.view = await request('PUT', `/api/cases/${state.token}/fields`, {
      holder: holder.value, amount: amount.value, shutoffDate: date.value, utilityId: utility.value || null,
    });
    state.screen = 'about';
  });
  return h('section', { class: 'card' },
    h('h2', {}, t().checkTitle), h('p', { class: 'hint' }, t().checkHint),
    state.view.urgent ? h('p', { class: 'notice' }, t().urgent) : null,
    field(t().holder, holder), field(t().amount, amount), field(t().shutoff, date), field(t().utility, utility),
    h('div', { class: 'row' }, button(t().next, save)));
}

function aboutScreen() {
  const hh = state.view.household ?? { size: 2, income: 'low', medical: false, minor: false, senior: false, phone: '', smsOptIn: false };
  const size = h('input', { type: 'number', min: 1, max: 20, value: hh.size });
  const income = h('select', {}, ...Object.entries(t().incomes).map(([k, v]) => h('option', { value: k, selected: k === hh.income }, v)));
  const check = (label, on) => { const box = h('input', { type: 'checkbox', checked: on }); return [box, h('label', { class: 'check' }, box, h('span', {}, label))]; };
  const [medical, medicalRow] = check(t().medical, hh.medical);
  const [minor, minorRow] = check(t().minor, hh.minor);
  const [senior, seniorRow] = check(t().senior, hh.senior);
  const phone = h('input', { type: 'tel', value: hh.phone ?? '', autocomplete: 'tel' });
  const [sms, smsRow] = check(`${t().sms}. ${state.config.consent.sms[state.lang]}`, hh.smsOptIn);
  const [consent, consentRow] = check(state.config.consent.text[state.lang], state.view.consentGiven);
  const save = () => guarded(async () => {
    state.view = await request('PUT', `/api/cases/${state.token}/household`, {
      size: Number(size.value), income: income.value, medical: medical.checked, minor: minor.checked, senior: senior.checked,
      phone: phone.value, smsOptIn: sms.checked, consent: consent.checked, language: state.lang,
    });
    state.screen = 'plan';
  });
  return h('section', { class: 'card' },
    h('h2', {}, t().aboutTitle), h('p', { class: 'hint' }, t().aboutHint),
    field(t().size, size), field(t().income, income), medicalRow, minorRow, seniorRow,
    field(t().phone, phone), smsRow,
    h('h2', {}, t().consentTitle), consentRow,
    h('div', { class: 'row' }, button(t().back, () => { state.screen = 'check'; render(); }, 'secondary'), button(t().next, save)));
}

function planCard(step) {
  const lang = state.lang;
  const entry = step.kind === 'entry';
  return h('li', { class: `step ${step.kind}` },
    h('h3', {}, step.title[lang]),
    step.kind === 'deadline' ? h('p', { class: 'badge' }, t().daysLeft(step.daysLeft)) : null,
    h('p', {}, step.body[lang]),
    step.documents?.length ? h('p', { class: 'hint' }, `${t().bring} ${step.documents.join(', ')}`) : null,
    step.phone ? h('p', {}, `${t().call}: `, h('a', { href: `tel:${step.phone.replace(/[^\d+]/g, '')}` }, step.phone)) : null,
    entry ? h('p', { class: 'hint' }, `${t().checked} ${dateLabel(step.verifiedOn, lang)} · `, h('a', { href: step.sourceUrl, rel: 'noopener noreferrer', target: '_blank' }, t().source)) : null);
}

function planScreen() {
  const submit = () => guarded(async () => {
    const res = await request('POST', `/api/cases/${state.token}/submit`);
    state.view = { ...state.view, status: res.status };
    state.screen = 'done';
  });
  const plan = state.view.plan;
  return h('section', { class: 'card' },
    h('h2', {}, t().planTitle),
    plan.needsStaff ? h('p', { class: 'notice' }, t().needsStaff) : null,
    h('ol', { class: 'steps' }, plan.steps.map(planCard)),
    h('div', { class: 'row' }, button(t().back, () => { state.screen = 'about'; render(); }, 'secondary'), button(state.busy ? t().sending : t().submit, submit)));
}

function doneScreen() {
  const link = `${location.origin}/#c=${state.token}`;
  const copy = async (e) => { try { await navigator.clipboard.writeText(link); e.target.textContent = t().copied; } catch { /* user can select the text */ } };
  return h('section', { class: 'card' },
    h('h2', {}, t().doneTitle), h('p', {}, t().doneBody),
    h('p', {}, `${t().statusLabel}: `, h('strong', {}, t().statuses[state.view.status] ?? state.view.status)),
    h('label', { class: 'field' }, h('span', { class: 'label' }, t().link), h('input', { type: 'text', readOnly: true, value: link, onfocus: (e) => e.target.select() })),
    h('div', { class: 'row' }, button(t().copy, copy, 'secondary'), button(t().startOver, () => { setToken(null); state.view = null; state.screen = 'start'; render(); }, 'secondary')),
    h('ol', { class: 'steps' }, (state.view.plan?.steps ?? []).map(planCard)));
}

const SCREENS = { start: startScreen, check: checkScreen, about: aboutScreen, plan: planScreen, done: doneScreen };

function render() {
  const focused = document.activeElement?.id;
  mount(root, header(), errorBox(), SCREENS[state.screen]());
  if (focused) document.getElementById(focused)?.focus();
}

async function boot() {
  document.documentElement.lang = state.lang;
  try { state.config = await request('GET', '/api/config'); } catch (err) { state.error = err.message; state.config = { utilities: [], consent: { text: { en: '', es: '' }, sms: { en: '', es: '' } }, photoReading: false }; }
  const token = tokenFromHash();
  if (token) {
    try {
      state.token = token;
      state.view = await request('GET', `/api/cases/${token}`);
      if (state.view.language && state.view.language !== state.lang) state.lang = state.view.language;
      state.screen = state.view.status === 'draft' ? (state.view.plan ? 'plan' : 'check') : 'done';
    } catch { setToken(null); state.error = t().notFound; }
  }
  render();
}

boot();
