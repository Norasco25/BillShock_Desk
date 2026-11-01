import { HttpError } from '../lib/errors.js';

/** A response with an explicit status, body and headers. Plain objects returned by handlers become JSON 200s. */
export class Reply {
  constructor(status, body, headers = {}) {
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { tooBig = true; chunks.length = 0; return; } // keep draining so we can still answer
      if (!tooBig) chunks.push(chunk);
    });
    req.on('end', () => (tooBig ? reject(new HttpError(413, 'That request is too large.')) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

async function parseBody(req, limit, allowForm) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return null;
  const raw = await readBody(req, limit);
  if (raw.length === 0) return {};
  const type = String(req.headers['content-type'] ?? '');
  if (type.includes('application/json')) {
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      throw new HttpError(400, 'The request body is not valid JSON.');
    }
  }
  // Browsers let any website submit a form to any address. Routes that act on
  // behalf of a signed-in person therefore accept JSON only. A route opts in
  // to form posts (the Twilio webhook does) with { form: true }.
  if (allowForm && type.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
  }
  throw new HttpError(415, 'Send JSON.');
}

export function sendReply(res, reply) {
  const { status, body, headers } = reply;
  if (Buffer.isBuffer(body) || typeof body === 'string') {
    res.writeHead(status, { 'content-length': Buffer.byteLength(body), ...headers });
    res.end(body);
    return;
  }
  const json = JSON.stringify(body ?? {});
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json), ...headers });
  res.end(json);
}

export function createRouter() {
  const routes = [];

  function add(method, pattern, options, handler) {
    if (typeof options === 'function') { handler = options; options = {}; }
    const keys = [];
    const source = pattern.replace(/:([A-Za-z]+)/g, (_, key) => { keys.push(key); return '([^/]+)'; });
    routes.push({
      method,
      re: new RegExp(`^${source}/?$`),
      keys,
      handler,
      guards: options.guards ?? [],
      bodyLimit: options.bodyLimit ?? 64 * 1024,
      allowForm: options.form === true,
    });
  }

  /** Returns true if a route handled the request. */
  async function dispatch(req, res, url, extra = {}) {
    const matches = routes
      .map((r) => ({ r, m: r.re.exec(url.pathname) }))
      .filter((x) => x.m);
    if (matches.length === 0) return false;

    const hit = matches.find((x) => x.r.method === req.method);
    if (!hit) throw new HttpError(405, 'Method not allowed.');

    const params = {};
    hit.r.keys.forEach((k, i) => {
      try { params[k] = decodeURIComponent(hit.m[i + 1]); } catch { throw new HttpError(400, 'Bad link.'); }
    });

    const ctx = { req, res, url, params, query: Object.fromEntries(url.searchParams), ...extra };
    for (const guard of hit.r.guards) await guard(ctx); // guards run before the body is read
    ctx.body = await parseBody(req, hit.r.bodyLimit, hit.r.allowForm);

    const result = await hit.r.handler(ctx);
    sendReply(res, result instanceof Reply ? result : new Reply(200, result ?? { ok: true }));
    return true;
  }

  return {
    get: (p, o, h) => add('GET', p, o, h),
    post: (p, o, h) => add('POST', p, o, h),
    put: (p, o, h) => add('PUT', p, o, h),
    delete: (p, o, h) => add('DELETE', p, o, h),
    dispatch,
  };
}
