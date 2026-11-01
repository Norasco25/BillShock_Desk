// A tiny helper for building page elements without innerHTML.
// Text is always added as text, never as markup, so a notice that contains
// "<script>" is displayed as words and cannot run.

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value') el.value = value;
    else if (key in el && key !== 'list') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function mount(root, ...nodes) {
  root.replaceChildren(...nodes.flat().filter(Boolean));
}

export async function request(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) {
    const err = new Error(data?.error ?? `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const money = (cents) => (cents == null ? '' : (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' }));

export function dateLabel(iso, lang = 'en') {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });
}
