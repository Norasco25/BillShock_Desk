import crypto from 'node:crypto';
import { HttpError } from '../lib/errors.js';
import { safeEqual } from '../lib/crypto.js';

/**
 * Sends text messages. With Twilio credentials it calls Twilio's REST API.
 * Without them it prints the message to the server log and keeps it in
 * `outbox`, so you can run the whole project with no accounts.
 */
export function createMessenger({ config, fetchImpl = globalThis.fetch, log = console }) {
  const { accountSid, authToken, from } = config.twilio;
  const live = Boolean(accountSid && authToken && from);
  const outbox = [];

  async function sendSms(to, body) {
    if (!live) {
      const ref = `console-${outbox.length + 1}`;
      outbox.push({ to, body, ref });
      log.log(`[sms:console] to ${to}: ${body.replace(/\s+/g, ' ').slice(0, 100)}`);
      return { ref };
    }
    const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Twilio responded with status ${res.status}`);
    const data = await res.json();
    return { ref: data.sid };
  }

  return { sendSms, outbox, mode: live ? 'twilio' : 'console' };
}

/**
 * The only way anything leaves the system. The row is written first. The
 * database triggers in src/db.js refuse the insert unless the case is approved,
 * consent is on file and (for texts) the household has not opted out. If the
 * insert succeeds we deliver, then record the result.
 */
export async function sendOutbound({ db, messenger, clock }, { caseId, channel, audience, kind, body, to }) {
  const now = clock.now().toISOString();
  let id;
  try {
    const info = db
      .prepare(
        `INSERT INTO outbound_messages (case_id, channel, audience, kind, body, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?)`,
      )
      .run(caseId, channel, audience, kind, body, now);
    id = Number(info.lastInsertRowid);
  } catch (err) {
    if (/send blocked/.test(err.message)) throw new HttpError(409, err.message);
    throw err;
  }

  if (channel === 'letter') {
    // No automatic delivery for letters: staff send them. We record that they did.
    db.prepare(`UPDATE outbound_messages SET status = 'sent', provider_ref = 'manual', sent_at = ? WHERE id = ?`).run(now, id);
    return { id };
  }

  try {
    const { ref } = await messenger.sendSms(to, body);
    db.prepare(`UPDATE outbound_messages SET status = 'sent', provider_ref = ?, sent_at = ? WHERE id = ?`).run(ref, now, id);
    return { id };
  } catch (err) {
    db.prepare(`UPDATE outbound_messages SET status = 'failed', error = ? WHERE id = ?`).run(String(err.message).slice(0, 200), id);
    throw new HttpError(502, 'The text message could not be sent. It is saved as failed.');
  }
}

// ----- inbound texts (Twilio webhook) -----

const STOP_WORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'];
const START_WORDS = ['START', 'YES', 'UNSTOP'];

export function parseKeyword(body) {
  const w = String(body ?? '').trim().toUpperCase();
  if (STOP_WORDS.includes(w)) return 'stop';
  if (START_WORDS.includes(w)) return 'start';
  return null;
}

/** Twilio signs each webhook: HMAC-SHA1 of the full URL plus the sorted POST fields. */
export function twilioSignature(authToken, url, params) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return crypto.createHmac('sha1', authToken).update(data).digest('base64');
}

export function verifyTwilioSignature({ authToken, url, params, signature }) {
  if (!signature) return false;
  return safeEqual(twilioSignature(authToken, url, params), signature);
}
