import fs from 'node:fs';
import { todayIn } from './lib/dates.js';
import { tx } from './db.js';
import { validateEntry } from './domain/library.js';
import { upsertEntry, upsertUtility } from './services/repo.js';

/**
 * Loads the example library the first time the app starts (when there are no
 * utilities yet). After that the database is the source of truth and staff
 * edit entries in the console.
 */
export function seedIfEmpty(db, { file, timezone, now = new Date() }) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM utilities').get();
  if (n > 0) return false;

  const today = todayIn(timezone, now);
  const seed = JSON.parse(fs.readFileSync(file, 'utf8'));

  tx(db, () => {
    for (const u of seed.utilities) upsertUtility(db, u);
    for (const raw of seed.entries) {
      const entry = validateEntry({ ...raw, verifiedOn: raw.verifiedOn === '@today' ? today : raw.verifiedOn }, { today });
      if (!entry.ok) throw new Error(`Seed entry ${raw.id} is invalid: ${entry.errors.join('; ')}`);
      upsertEntry(db, entry.value);
    }
  });
  return true;
}
