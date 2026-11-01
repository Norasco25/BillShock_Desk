import { HttpError } from '../lib/errors.js';
import { decryptText, encrypt, hashToken, newToken } from '../lib/crypto.js';
import { plusDaysIso, todayIn } from '../lib/dates.js';
import { centsToDollarString } from '../lib/money.js';
import { normalizePhone } from '../lib/phone.js';
import { asBool, asInt, asObject, asOneOf, asString } from '../lib/validate.js';
import { tx } from '../db.js';
import { CONSENT_SCOPE, CONSENT_TEXT, CONSENT_VERSION } from '../domain/consent.js';
import { validateFields } from '../domain/fields.js';
import { INCOMES } from '../domain/library.js';
import { publicPlan } from '../domain/plan.js';
import { audit, findCaseIdByToken, getUtility, listUtilities, loadCase } from './repo.js';
import { rebuildPlan } from './planning.js';
import { validateImage } from './ai.js';

/** What a household is allowed to see about its own case. Staff-only reasons are left out. */
export function toHouseholdView(agg, db) {
  const utility = agg.utilityId ? getUtility(db, agg.utilityId) : null;
  return {
    status: agg.status,
    language: agg.language,
    urgent: agg.urgency.length > 0,
    fields: {
      holder: agg.holder,
      amount: agg.amountCents == null ? '' : centsToDollarString(agg.amountCents),
      shutoffDate: agg.shutoffDate,
      utilityId: agg.utilityId,
      utilityName: utility?.name ?? null,
      utilityNameOnNotice: agg.utilityNameOnNotice,
    },
    household: agg.household && {
      size: agg.household.size,
      income: agg.household.income,
      medical: agg.household.medical,
      minor: agg.household.minor,
      senior: agg.household.senior,
      phone: agg.household.phone,
      smsOptIn: agg.household.smsOptIn,
    },
    consentGiven: Boolean(agg.consent),
    plan: publicPlan(agg.plan),
    outcome: agg.outcome ? { type: agg.outcome.type } : null,
  };
}

export function createIntake({ db, config, clock, extractor }) {
  const now = () => clock.now();
  const nowIso = () => now().toISOString();
  const today = () => todayIn(config.timezone, now());

  function caseFor(token, { draftOnly = false } = {}) {
    const id = findCaseIdByToken(db, token, nowIso());
    if (!id) throw new HttpError(404, 'We could not find that case. The link may have expired.');
    const agg = loadCase(db, id);
    if (draftOnly && agg.status !== 'draft') {
      throw new HttpError(409, 'This case was already sent to staff. Contact staff to change it.');
    }
    return agg;
  }

  /** Step 1: read the notice and open a private draft case. */
  async function start(input) {
    const body = asObject(input);
    const language = asOneOf(body.language, 'language', ['en', 'es'], { fallback: 'en' });
    const text = typeof body.text === 'string' ? body.text.slice(0, 20_000) : null;

    let image = null;
    if (body.image) {
      image = validateImage(body.image);
      if (!image || image.error) throw new HttpError(400, image?.error ?? 'The photo could not be read.');
    }
    if (!text?.trim() && !image) throw new HttpError(400, 'Add the text of your notice or a photo of it.');

    const utilities = listUtilities(db);
    const result = await extractor.extract({ text, image }, utilities);
    if (!result.ok) {
      return { ok: false, retake: result.reason === 'unreadable', reason: result.reason, missing: result.missing ?? [] };
    }

    // Same validators as typed input. (The date range check waits until the household confirms.)
    const checked = validateFields(result.fields, utilities);
    if (!checked.ok) return { ok: false, retake: true, reason: 'unreadable', missing: Object.keys(checked.errors) };
    const f = checked.value;

    const token = newToken();
    const created = nowIso();
    const caseId = tx(db, () => {
      const info = db
        .prepare(
          `INSERT INTO cases (token_hash, token_expires_at, status, language, utility_id, utility_name_on_notice,
             holder, amount_cents, shutoff_date, notice_phone, notice_flags, created_at)
           VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          hashToken(token),
          plusDaysIso(now(), config.tokenTtlDays),
          language,
          f.utilityId,
          result.fields.utilityNameOnNotice ?? null,
          f.holder,
          f.amountCents,
          f.shutoffDate,
          f.noticePhone,
          JSON.stringify(result.urgency ?? []),
          created,
        );
      const id = Number(info.lastInsertRowid);
      db.prepare('INSERT INTO notices (case_id, text_enc, image_enc, media_type) VALUES (?, ?, ?, ?)').run(
        id,
        result.transcription ? encrypt(config.noticeKey, result.transcription) : null,
        image ? encrypt(config.noticeKey, Buffer.from(image.data, 'base64')) : null,
        image ? image.mediaType : null,
      );
      audit(db, created, 'household', image ? 'intake_started_photo' : 'intake_started_text', id);
      return id;
    });

    return { ok: true, token, view: toHouseholdView(loadCase(db, caseId), db) };
  }

  function view(token) {
    return toHouseholdView(caseFor(token), db);
  }

  /** Step 2: the household confirms or corrects what we read. */
  function updateFields(token, input) {
    const agg = caseFor(token, { draftOnly: true });
    const body = asObject(input);
    const utilities = listUtilities(db);
    const checked = validateFields(
      {
        holder: body.holder,
        amount: body.amount,
        shutoffDate: body.shutoffDate,
        utilityId: body.utilityId ?? null,
        noticePhone: agg.noticePhone,
      },
      utilities,
      { today: today() },
    );
    if (!checked.ok) throw new HttpError(400, 'Please fix the highlighted fields.', { fieldErrors: checked.errors });

    const v = checked.value;
    db.prepare('UPDATE cases SET holder = ?, amount_cents = ?, shutoff_date = ?, utility_id = ? WHERE id = ?').run(
      v.holder, v.amountCents, v.shutoffDate, v.utilityId, agg.id,
    );
    rebuildPlan({ db, config, clock }, agg.id); // no-op until the household step is saved
    return toHouseholdView(loadCase(db, agg.id), db);
  }

  /** Step 3: household details, texting choice and consent. Builds the plan. */
  function saveHousehold(token, input) {
    const agg = caseFor(token, { draftOnly: true });
    const body = asObject(input);

    if (body.consent !== true) throw new HttpError(400, 'Consent is required to continue.');
    const language = asOneOf(body.language, 'language', ['en', 'es'], { fallback: agg.language });
    const phone = normalizePhone(typeof body.phone === 'string' ? body.phone : '');
    if (!phone) throw new HttpError(400, 'Enter a 10-digit US phone number.', { fieldErrors: { phone: 'Enter a 10-digit US phone number.' } });

    const h = {
      size: asInt(body.size, 'People in your home', { min: 1, max: 30 }),
      income: asOneOf(body.income, 'Income', INCOMES),
      medical: asBool(body.medical ?? false, 'medical'),
      minor: asBool(body.minor ?? false, 'minor'),
      senior: asBool(body.senior ?? false, 'senior'),
      sms: asBool(body.smsOptIn ?? false, 'smsOptIn'),
    };

    tx(db, () => {
      db.prepare(
        `INSERT INTO households (case_id, size, income, medical, minor, senior, phone, sms_opt_in)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(case_id) DO UPDATE SET size = excluded.size, income = excluded.income, medical = excluded.medical,
           minor = excluded.minor, senior = excluded.senior, phone = excluded.phone, sms_opt_in = excluded.sms_opt_in`,
      ).run(agg.id, h.size, h.income, +h.medical, +h.minor, +h.senior, phone, +h.sms);

      // Store exactly the words this person was shown.
      db.prepare(
        `INSERT INTO consents (case_id, version, text, scope, given_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(case_id) DO UPDATE SET version = excluded.version, text = excluded.text,
           scope = excluded.scope, given_at = excluded.given_at`,
      ).run(agg.id, CONSENT_VERSION, CONSENT_TEXT[language], CONSENT_SCOPE, nowIso());

      db.prepare('UPDATE cases SET language = ? WHERE id = ?').run(language, agg.id);
      rebuildPlan({ db, config, clock }, agg.id);
      audit(db, nowIso(), 'household', 'consent_recorded', agg.id);
    });

    return toHouseholdView(loadCase(db, agg.id), db);
  }

  /** Step 4: hand the case to staff. After this the household can no longer edit it. */
  function submit(token) {
    const agg = caseFor(token, { draftOnly: true });
    if (!agg.household || !agg.consent || !agg.plan) {
      throw new HttpError(409, 'Finish the earlier steps before sending your case to staff.');
    }
    tx(db, () => {
      db.prepare(`UPDATE cases SET status = 'in_review', submitted_at = ? WHERE id = ?`).run(nowIso(), agg.id);
      audit(db, nowIso(), 'household', 'submitted', agg.id);
    });
    return toHouseholdView(loadCase(db, agg.id), db);
  }

  return { start, view, updateFields, saveHousehold, submit };
}

/** Used by staff routes to show the notice text. Returns null if it was deleted. */
export function readNoticeText(db, key, caseId) {
  const row = db.prepare('SELECT text_enc FROM notices WHERE case_id = ?').get(caseId);
  return row?.text_enc ? decryptText(key, row.text_enc) : null;
}
