import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const int = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Reads settings from environment variables. Takes `env` as an argument
 * (instead of reading process.env directly) so tests can pass their own.
 */
export function loadConfig(env = process.env, { cwd = process.cwd() } = {}) {
  const production = env.NODE_ENV === 'production';
  const dataDir = path.resolve(cwd, env.DATA_DIR || 'data');
  const warnings = [];

  // Key for encrypting notices.
  let noticeKey = env.NOTICE_KEY ? Buffer.from(env.NOTICE_KEY, 'hex') : null;
  if (noticeKey && noticeKey.length !== 32) {
    throw new Error('NOTICE_KEY must be 64 hex characters (32 bytes). Generate one with: npm run keygen');
  }
  if (!noticeKey) {
    if (production) throw new Error('NOTICE_KEY is required in production.');
    fs.mkdirSync(dataDir, { recursive: true });
    const keyFile = path.join(dataDir, 'dev-notice.key');
    if (fs.existsSync(keyFile)) {
      noticeKey = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
    } else {
      noticeKey = crypto.randomBytes(32);
      fs.writeFileSync(keyFile, noticeKey.toString('hex'), { mode: 0o600 });
    }
    warnings.push('NOTICE_KEY is not set. Using a development key from data/dev-notice.key.');
  }

  // Staff logins: "name:password,name2:password2".
  let staffUsers = (env.STAFF_USERS || '')
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf(':');
      return i > 0 ? { name: pair.slice(0, i), password: pair.slice(i + 1) } : null;
    })
    .filter(Boolean);
  if (staffUsers.length === 0) {
    if (production) throw new Error('STAFF_USERS is required in production (name:password,...).');
    staffUsers = [{ name: 'staff', password: 'staff-dev-password' }];
    warnings.push('STAFF_USERS is not set. Staff login is staff / staff-dev-password.');
  }

  return {
    production,
    host: env.HOST || '127.0.0.1',
    port: int(env.PORT, 3000),
    dataDir,
    dbFile: path.join(dataDir, 'bill-shock-desk.sqlite'),
    noticeKey,
    staffUsers,
    timezone: env.TIMEZONE || 'America/New_York',
    anthropicKey: env.ANTHROPIC_API_KEY || '',
    claudeModel: env.CLAUDE_MODEL || 'claude-sonnet-5-5',
    twilio: {
      accountSid: env.TWILIO_ACCOUNT_SID || '',
      authToken: env.TWILIO_AUTH_TOKEN || '',
      from: env.TWILIO_FROM || '',
    },
    staffAlertPhone: env.STAFF_ALERT_PHONE || '',
    publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
    trustProxy: env.TRUST_PROXY === '1',
    noticeRetentionDays: int(env.NOTICE_RETENTION_DAYS, 0),
    piiRetentionDays: int(env.PII_RETENTION_DAYS, 30),
    draftTtlHours: int(env.DRAFT_TTL_HOURS, 24),
    tokenTtlDays: int(env.TOKEN_TTL_DAYS, 30),
    largeBalanceCents: int(env.LARGE_BALANCE_CENTS, 40_000),
    reminderOffsets: (env.REMINDER_OFFSETS || '3,1,0')
      .split(',')
      .map((n) => Number.parseInt(n, 10))
      .filter((n) => Number.isInteger(n) && n >= 0),
    warnings,
  };
}
