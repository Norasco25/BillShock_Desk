import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './lib/errors.js';
import { createRouter, sendReply, Reply } from './http/router.js';
import { applySecurityHeaders, createRateLimiter, createStaffAuth } from './http/security.js';
import { serveStatic } from './http/static.js';
import { createExtractor } from './services/ai.js';
import { createIntake } from './services/intake.js';
import { createMessenger } from './services/messaging.js';
import { createStaff } from './services/staff.js';
import { registerPublicRoutes } from './routes/public.js';
import { registerStaffRoutes } from './routes/staff.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/**
 * Wires everything together. Every dependency is passed in, so tests can swap
 * the clock, the database, the text-message sender and the notice reader.
 */
export function createApp({
  config,
  db,
  clock = { now: () => new Date() },
  messenger = createMessenger({ config }),
  extractor = createExtractor({ config }),
}) {
  const limiter = createRateLimiter();
  const intake = createIntake({ db, config, clock, extractor });
  const staff = createStaff({ db, config, clock, messenger });
  const authenticate = createStaffAuth({ users: config.staffUsers, limit: limiter, trustProxy: config.trustProxy });

  const router = createRouter();
  registerPublicRoutes(router, { db, config, clock, intake, extractor, limiter });
  registerStaffRoutes(router, { staff, authenticate });

  async function handle(req, res) {
    try {
      applySecurityHeaders(res);
      const url = new URL(req.url, 'http://localhost');

      if (url.pathname.startsWith('/api/')) {
        if (!(await router.dispatch(req, res, url))) throw new HttpError(404, 'Not found.');
        return;
      }

      if (url.pathname === '/staff') {
        res.writeHead(302, { location: '/staff/' });
        res.end();
        return;
      }
      if (url.pathname.startsWith('/staff/')) authenticate(req); // the console's files are staff-only too

      if (!(await serveStatic(req, res, url.pathname, PUBLIC_DIR))) throw new HttpError(404, 'Not found.');
    } catch (err) {
      respondWithError(res, err);
    }
  }

  const server = http.createServer(handle);
  return { server, intake, staff, messenger, limiter };
}

function respondWithError(res, err) {
  if (res.headersSent) { res.end(); return; }
  if (err instanceof HttpError) {
    const { headers = {}, ...rest } = err.details ?? {};
    sendReply(res, new Reply(err.status, { error: err.message, ...rest }, headers));
    return;
  }
  console.error('[server] unexpected error:', err);
  sendReply(res, new Reply(500, { error: 'Something went wrong on our side.' }));
}
