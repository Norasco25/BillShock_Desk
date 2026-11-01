import { DatabaseSync } from 'node:sqlite';

/**
 * Run `fn` inside a transaction. `fn` must be synchronous: SQLite
 * transactions cannot span an `await`.
 */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

// Each entry runs once, in order. Never edit an entry that has shipped; add a new one.
const MIGRATIONS = [
  /* 1: initial schema */ `
  CREATE TABLE utilities (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    state     TEXT NOT NULL,
    patterns  TEXT NOT NULL            -- JSON array of regex sources that identify this utility on a notice
  );

  CREATE TABLE library_entries (
    id             TEXT PRIMARY KEY,
    utility_id     TEXT NOT NULL REFERENCES utilities(id),
    kind           TEXT NOT NULL CHECK (kind IN ('payment_plan','protection','assistance')),
    rank           INTEGER NOT NULL,   -- lower shows first in a plan
    title_en       TEXT NOT NULL,
    title_es       TEXT NOT NULL,
    body_en        TEXT NOT NULL,
    body_es        TEXT NOT NULL,
    phone          TEXT,
    documents_json TEXT NOT NULL DEFAULT '[]',
    when_json      TEXT NOT NULL DEFAULT '{}',   -- who this applies to (see domain/library.js)
    ask_letter     TEXT NOT NULL DEFAULT '',
    ask_script_en  TEXT NOT NULL DEFAULT '',
    ask_script_es  TEXT NOT NULL DEFAULT '',
    source_url     TEXT NOT NULL,
    verified_on    TEXT NOT NULL,      -- YYYY-MM-DD
    verified_by    TEXT NOT NULL,
    ttl_days       INTEGER NOT NULL CHECK (ttl_days > 0),
    active         INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE cases (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash              TEXT NOT NULL UNIQUE,
    token_expires_at        TEXT NOT NULL,
    status                  TEXT NOT NULL CHECK (status IN ('draft','in_review','approved','sent','rejected','closed')),
    language                TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en','es')),
    utility_id              TEXT REFERENCES utilities(id),
    utility_name_on_notice  TEXT,
    holder                  TEXT,
    amount_cents            INTEGER,
    shutoff_date            TEXT,
    notice_phone            TEXT,
    notice_flags            TEXT NOT NULL DEFAULT '[]',   -- urgency found in the notice text
    plan_json               TEXT,
    letter                  TEXT,
    script                  TEXT,
    approved_at             TEXT,
    approved_by             TEXT,
    created_at              TEXT NOT NULL,
    submitted_at            TEXT,
    closed_at               TEXT,
    notice_purge_at         TEXT,
    pii_purge_at            TEXT,
    pii_purged_at           TEXT
  );
  CREATE INDEX cases_status_idx ON cases(status);

  CREATE TABLE households (
    case_id          INTEGER PRIMARY KEY REFERENCES cases(id) ON DELETE CASCADE,
    size             INTEGER NOT NULL CHECK (size BETWEEN 1 AND 30),
    income           TEXT NOT NULL CHECK (income IN ('low','mid','high')),
    medical          INTEGER NOT NULL,
    minor            INTEGER NOT NULL,
    senior           INTEGER NOT NULL,
    phone            TEXT NOT NULL,
    sms_opt_in       INTEGER NOT NULL,
    sms_stopped_at   TEXT
  );

  -- The notice itself. Text and image are encrypted before they reach this table.
  CREATE TABLE notices (
    case_id     INTEGER PRIMARY KEY REFERENCES cases(id) ON DELETE CASCADE,
    text_enc    BLOB,
    image_enc   BLOB,
    media_type  TEXT,
    deleted_at  TEXT
  );

  CREATE TABLE consents (
    case_id   INTEGER PRIMARY KEY REFERENCES cases(id) ON DELETE CASCADE,
    version   TEXT NOT NULL,
    text      TEXT NOT NULL,       -- the exact words the household agreed to
    scope     TEXT NOT NULL,
    given_at  TEXT NOT NULL
  );

  CREATE TABLE staff_checks (
    case_id      INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    step_idx     INTEGER NOT NULL,
    resolved_by  TEXT NOT NULL,
    resolved_at  TEXT NOT NULL,
    PRIMARY KEY (case_id, step_idx)
  );

  CREATE TABLE actions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id     INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('call','message','filing','note')),
    minutes     INTEGER NOT NULL DEFAULT 0 CHECK (minutes >= 0),
    text        TEXT NOT NULL,
    actor       TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE outcomes (
    case_id        INTEGER PRIMARY KEY REFERENCES cases(id) ON DELETE CASCADE,
    type           TEXT NOT NULL CHECK (type IN ('plan_confirmed','extension','assistance_applied','shutoff_happened','no_response')),
    dollars_cents  INTEGER NOT NULL CHECK (dollars_cents >= 0),
    recorded_by    TEXT NOT NULL,
    recorded_at    TEXT NOT NULL
  );

  -- Every message that leaves the system is recorded here first (an "outbox").
  CREATE TABLE outbound_messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id       INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    channel       TEXT NOT NULL CHECK (channel IN ('sms','letter')),
    audience      TEXT NOT NULL CHECK (audience IN ('household','utility','staff')),
    kind          TEXT NOT NULL CHECK (kind IN ('script','letter','reminder','alert')),
    body          TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('queued','sent','failed')),
    provider_ref  TEXT,
    error         TEXT,
    created_at    TEXT NOT NULL,
    sent_at       TEXT
  );

  CREATE TABLE reminders_sent (
    case_id      INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    offset_days  INTEGER NOT NULL,
    audience     TEXT NOT NULL,
    sent_at      TEXT NOT NULL,
    PRIMARY KEY (case_id, offset_days, audience)
  );

  -- Who did what, when. No personal content. case_id is deliberately not a foreign key,
  -- so deleting a case never deletes its history.
  CREATE TABLE audit_log (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id  INTEGER,
    actor    TEXT NOT NULL,
    event    TEXT NOT NULL,
    at       TEXT NOT NULL
  );

  -- ===== Safety rules enforced by the database itself =====

  -- 1. Nothing goes to the household or the utility unless staff approved the case
  --    and the household's consent is on file. Staff alerts are exempt.
  CREATE TRIGGER outbound_requires_approval_and_consent
  BEFORE INSERT ON outbound_messages
  WHEN NEW.audience <> 'staff'
  BEGIN
    SELECT RAISE(ABORT, 'send blocked: case is not approved')
    WHERE NOT EXISTS (
      SELECT 1 FROM cases
      WHERE id = NEW.case_id AND approved_at IS NOT NULL AND status IN ('approved','sent')
    );
    SELECT RAISE(ABORT, 'send blocked: no recorded consent')
    WHERE NOT EXISTS (SELECT 1 FROM consents WHERE case_id = NEW.case_id);
  END;

  -- 2. No texts to someone who did not opt in or who replied STOP.
  CREATE TRIGGER no_sms_without_opt_in
  BEFORE INSERT ON outbound_messages
  WHEN NEW.channel = 'sms' AND NEW.audience = 'household'
  BEGIN
    SELECT RAISE(ABORT, 'send blocked: household has not opted in to texts or has opted out')
    WHERE EXISTS (
      SELECT 1 FROM households
      WHERE case_id = NEW.case_id AND (sms_opt_in = 0 OR sms_stopped_at IS NOT NULL)
    ) OR NOT EXISTS (SELECT 1 FROM households WHERE case_id = NEW.case_id);
  END;

  -- 3. A case cannot be approved without consent.
  CREATE TRIGGER approval_requires_consent
  BEFORE UPDATE OF approved_at ON cases
  WHEN NEW.approved_at IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT, 'approval blocked: no recorded consent')
    WHERE NOT EXISTS (SELECT 1 FROM consents WHERE case_id = NEW.id);
  END;

  -- 4. The audit log can only grow.
  CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  `,
];

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let i = current; i < MIGRATIONS.length; i += 1) {
    tx(db, () => db.exec(MIGRATIONS[i]));
    db.exec(`PRAGMA user_version = ${i + 1}`);
  }
}
