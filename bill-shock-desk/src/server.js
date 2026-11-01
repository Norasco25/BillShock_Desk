import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { seedIfEmpty } from './seed.js';
import { createApp } from './app.js';
import { startJobs } from './services/jobs.js';

const config = loadConfig();
config.warnings.forEach((w) => console.warn(`[config] ${w}`));

const db = openDb(config.dbFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (seedIfEmpty(db, { file: path.join(root, 'data', 'seed', 'library.json'), timezone: config.timezone })) {
  console.warn('[seed] Loaded the EXAMPLE library. Replace it with verified entries before real use.');
}

const clock = { now: () => new Date() };
const { server, messenger } = createApp({ config, db, clock });
const stopJobs = startJobs({ db, config, clock, messenger });

server.listen(config.port, config.host, () => {
  console.log(`Bill Shock Desk is running at http://${config.host}:${config.port}`);
  console.log(`  Households:  http://${config.host}:${config.port}/`);
  console.log(`  Staff:       http://${config.host}:${config.port}/staff/`);
  console.log(`  Texts:       ${messenger.mode === 'twilio' ? 'sent with Twilio' : 'printed to this log (no Twilio settings)'}`);
});

function shutdown() {
  stopJobs();
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
