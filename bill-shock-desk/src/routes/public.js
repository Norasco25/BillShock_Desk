import { HttpError } from '../lib/errors.js';
import { normalizePhone } from '../lib/phone.js';
import { clientIp } from '../http/security.js';
import { Reply } from '../http/router.js';
import { audit, listUtilities } from '../services/repo.js';
import { parseKeyword, verifyTwilioSignature } from '../services/messaging.js';
import { CONSENT_SCOPE, CONSENT_TEXT, CONSENT_VERSION, SMS_TEXT } from '../domain/consent.js';

/** Endpoints for households. No sign-in: a household's private link token is its key. */
export function registerPublicRoutes(router, { db, config, clock, intake, extractor, limiter }) {
  const perIp = (name, max, windowMs) => (ctx) =>
    limiter({ key: `${name}:${clientIp(ctx.req, config.trustProxy)}`, max, windowMs });

  const browse = perIp('browse', 600, 10 * 60 * 1000);

  router.get('/api/health', () => ({ ok: true }));

  router.get('/api/config', { guards: [browse] }, () => ({
    utilities: listUtilities(db).map((u) => ({ id: u.id, name: u.name })),
    consent: { version: CONSENT_VERSION, scope: CONSENT_SCOPE, text: CONSENT_TEXT, sms: SMS_TEXT },
    photoReading: extractor.aiEnabled,
  }));

  // Reading a notice can cost money (AI), so this one is rate limited harder.
  router.post('/api/cases', { guards: [perIp('start', 20, 60 * 60 * 1000)], bodyLimit: 8 * 1024 * 1024 }, async ({ body }) => {
    const result = await intake.start(body);
    return result.ok ? new Reply(201, result) : new Reply(422, result);
  });

  router.get('/api/cases/:token', { guards: [browse] }, ({ params }) => intake.view(params.token));
  router.put('/api/cases/:token/fields', { guards: [browse] }, ({ params, body }) => intake.updateFields(params.token, body));
  router.put('/api/cases/:token/household', { guards: [browse] }, ({ params, body }) => intake.saveHousehold(params.token, body));
  router.post('/api/cases/:token/submit', { guards: [browse] }, ({ params }) => intake.submit(params.token));

  // Twilio calls this when someone replies to a text. STOP must always work.
  router.post('/api/sms/inbound', { form: true, bodyLimit: 16 * 1024 }, ({ req, body }) => {
    const { authToken } = config.twilio;
    if (authToken) {
      if (!config.publicBaseUrl) throw new HttpError(503, 'PUBLIC_BASE_URL must be set to verify inbound texts.');
      const ok = verifyTwilioSignature({
        authToken,
        url: `${config.publicBaseUrl}/api/sms/inbound`,
        params: body,
        signature: req.headers['x-twilio-signature'],
      });
      if (!ok) throw new HttpError(403, 'Bad signature.');
    } else if (config.production) {
      throw new HttpError(503, 'Inbound texts are not configured.');
    }

    const phone = normalizePhone(body.From ?? '');
    const keyword = parseKeyword(body.Body);
    if (phone && keyword) {
      const now = clock.now().toISOString();
      const ids = db.prepare('SELECT case_id FROM households WHERE phone = ?').all(phone);
      db.prepare('UPDATE households SET sms_stopped_at = ? WHERE phone = ?').run(keyword === 'stop' ? now : null, phone);
      ids.forEach(({ case_id: id }) => audit(db, now, 'household', keyword === 'stop' ? 'sms_stop' : 'sms_start', id));
    }
    return new Reply(200, '<?xml version="1.0" encoding="UTF-8"?><Response></Response>', { 'content-type': 'text/xml' });
  });
}
