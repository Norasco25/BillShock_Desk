# Bill Shock Desk

A small web service that helps households respond to a utility shutoff or past-due notice, and gives a staff team a console to review and send the help requests.

A household pastes its notice, confirms what was read, describes who lives in the home, and gets a plan of concrete steps with phone numbers and deadlines. Staff then review the case, check anything flagged, approve it, and send a letter and a phone script. The codebase is written to be read: it has no dependencies, no build step, and each file does one job.

> **The example data is fake.** The utility "Example Power & Light", its phone numbers, links and rules are invented so the project runs out of the box. Every entry says `EXAMPLE DATA - not verified`. Replace them with entries a person has checked against the utility's real published rules before anyone relies on this.

## Run it

You need **Node 22.13 or newer**. There is nothing to install.

```bash
npm start
# households:  http://127.0.0.1:3000/
# staff:       http://127.0.0.1:3000/staff/   (development login: staff / staff-dev-password)
npm test      # 38 tests
```

Texts are printed to the terminal unless Twilio is configured. Copy `.env.example` for every setting. In production (`NODE_ENV=production`) the server refuses to start without `NOTICE_KEY` (run `npm run keygen`) and `STAFF_USERS` (`name:password,name:password`).

Why no dependencies? Node 22 ships an HTTP server, SQLite (`node:sqlite`), crypto and a test runner. Using them keeps every mechanism visible instead of hidden inside a framework. If you later want Express or better-sqlite3, the seams are `src/http/router.js` and `src/db.js`.

## How a case moves

```
household pastes notice → fields confirmed → household + consent → plan built → submitted
   → staff: resolve flagged checks → approve → send letter / script → log work
   → record outcome → close (notice deleted) → personal data scrubbed after 30 days
```

## The rules that matter most

These are enforced twice: in plain functions you can unit test, and as SQLite triggers, so a bug in the app code still cannot break them.

1. **Nothing leaves without a person.** Sending requires an approved case, and approval requires recorded consent.
2. **Only library facts.** Plans and drafts contain only entries from the verified library. Each draft sentence carries a `[ref:ID]`; `domain/traceability.js` rejects a sentence whose ref is missing, retired or out of date, and any phone number not in the library. Tags are stripped before sending.
3. **Out-of-date means hidden.** Each entry has a re-check window (`ttlDays`). Past it, the entry disappears from plans until a person verifies it again.
4. **Flagged steps need a human.** Large balances and gaps in the library create checks staff must resolve first.
5. **STOP always works.** After STOP, no text is sent, enforced in the database.
6. **Editing removes approval.** Change a draft after approving and you must approve again.
7. **The audit log is append-only**, and names who did what.
8. **Privacy by default.** Notices are encrypted (AES-256-GCM), deleted on close, unfinished drafts are deleted after 24 hours, personal data is scrubbed after 30 days while anonymous results remain.

## Layout and suggested reading order

| Read | Why |
|---|---|
| `src/db.js` | The schema and the safety triggers. Start here. |
| `src/domain/` | Pure functions, no I/O: `plan.js`, `drafts.js`, `traceability.js`, `gate.js`, `library.js`. |
| `test/domain.test.js`, `test/db.test.js` | What each rule means, as examples. |
| `src/services/` | Use cases: `intake.js` (household), `staff.js` (console), `messaging.js`, `jobs.js`. |
| `src/http/`, `src/routes/`, `src/app.js` | Router, security headers, rate limits, auth, endpoints. |
| `test/flow.test.js` | The whole journey over real HTTP. |
| `public/` | The two front ends, plain JavaScript modules. Text is added as text, never as HTML. |

## Settings worth knowing

`ANTHROPIC_API_KEY` turns on reading photos of notices with Claude (output is treated as untrusted, validated, and the household confirms it). Without it, pasted text is read by pattern matching. `TWILIO_*` and `PUBLIC_BASE_URL` turn on real texts and signature-checked replies. `LARGE_BALANCE_CENTS`, `REMINDER_OFFSETS`, and the retention settings are in `.env.example`.

## Exercises

1. Add a second utility in the staff Library tab and paste a notice from it.
2. Add a new `when` condition (for example `renter`) in `library.js`, the household form, and a test.
3. Write a failing test for a rule you think is missing, then make it pass.
4. Replace the in-memory rate limiter with one stored in SQLite.
5. Add a staff "assigned to" field and show it in the queue.

## Before real use

- Have a lawyer review the consent and service wording in `src/domain/consent.js`.
- Have a native speaker review the Spanish in `public/i18n.js` and the library.
- Replace the example library with verified entries and keep the re-check dates honest.
- The Claude and Twilio code paths are tested with fake network calls, not against live services. Try them with test credentials first.
- Run behind HTTPS and set `TRUST_PROXY=1` only if a proxy you control sets `X-Forwarded-For`.
- Staff sign-in is HTTP Basic with a failed-attempt limiter. That is fine for a small team over HTTPS; use real single sign-on for anything larger.
- Back up `data/` (the SQLite file and key). Losing `NOTICE_KEY` makes stored notices unreadable.
