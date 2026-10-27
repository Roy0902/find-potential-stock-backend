# Backend

Fastify + TypeScript API for the find-potential-stock archive. Serves the public comment archive
and the owner admin endpoints.

This folder lives at the workspace root (`C:\Users\pigcr\Documents\Workspace\find-potential-stock-backend`), outside the
`find-potential-stock` git repository. The database tooling stays in
`../find-potential-stock/local-env/`.

## Requirements

- Node.js 22 or later
- PostgreSQL 16 or later with `pg_trgm`
- A seeded database (see below)
- Chromium for the scraper: `npx playwright install chromium`

## Quick start

```bash
npm install
cp .env.example .env          # adjust DATABASE_URL if your PostgreSQL password differs

# one-time database setup, from the other folder
cd ../find-potential-stock/local-env
npm install
npm run db:setup
npm run db:seed
cd ../../find-potential-stock-backend

npm run dev                   # http://localhost:3000
```

`GET /api/health` returns `200` with `data.database = "up"` once the database is reachable.

## Scripts

| Script | Purpose |
| :-- | :-- |
| `npm run dev` | Watch mode on port 3000 |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled build |
| `npm test` | Unit tests + integration tests against the seeded database |
| `npm run typecheck` | Type check without emitting |
| `npm run scrape` | Run the LIHKG pipeline once for every `SCRAPE_KEYWORDS` entry (manual/backfill) |
| `npm run scrape:dist` | Same, using the compiled `dist/` build (production deps only) |

## Environment variables

| Variable | Default | Purpose |
| :-- | :-- | :-- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/find_potential_stock` | PostgreSQL connection |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed origins, comma separated |
| `SESSION_TTL_MINUTES` | `30` | Owner session inactivity limit |
| `LOGIN_RATE_LIMIT` | `5` | Failed logins per window |
| `LOGIN_RATE_WINDOW_MINUTES` | `15` | Rate-limit window |
| `SECURE_COOKIES` | `false` | Force `Secure` cookies (also on when `NODE_ENV=production`) |
| `LOG_LEVEL` | `info` | Fastify log level |

## Scheduled scraper

The API process can run the LIHKG pipeline on a cron schedule. It is **disabled by default**
(`SCRAPE_ENABLED=false`) so local development, tests and Playwright never scrape by accident.

```bash
npx playwright install chromium

# manual run, writes to the database
npm run scrape -- --limit 1

# scrape and log without writing to the database
npm run scrape -- --limit 1 --dry-run

# scheduler smoke test
SCRAPE_ENABLED=true SCRAPE_RUN_ON_START=true npm run dev
```

`npm run scrape` and the scheduler run every entry in `SCRAPE_KEYWORDS`, one after
another. Pass `--keyword "<text>"` to the CLI to run a single keyword.

Each keyword run:

1. Looks up the source (`SCRAPE_SOURCE=LIHKG`).
2. Closes any `running` row older than `SCRAPE_STALE_MINUTES` as `failed` (`stop_reason=stale`).
3. Skips if another `scrape_run` is still `running`.
4. Inserts a `running` row with its log path.
5. Spawns `scripts/scrape/lihkg-keyword-pipeline.mjs` with `--json-logs`.
6. Streams the script's events into the log file.
7. Ingests every `thread-*-comments.json` file it produced.
8. Closes the row as `success`, `partial` or `failed`, then emails any errors.

### Ingestion rules

- Every matched thread is re-scraped on every run. Existing `post_id`s are skipped
  (`ON CONFLICT DO NOTHING`); only unseen comments are inserted.
- `last_seen_at` is refreshed for every comment the source still returns.
- A comment that disappears from a **complete** thread scrape becomes
  `is_hidden=true, hidden_reason='source_removed'`. Admin-hidden comments keep `admin`.
- An incomplete thread is ingested but never hides anything. A complete scrape that returns zero
  comments is logged as a warning and also hides nothing, so a layout change cannot wipe the archive.
- A quoted `post_id` becomes `parent_external_id` and is resolved to `parent_id`. If the quoted
  comment was not scraped, `reply_target_unknown=true`.
- Thread status `3` (deleted) is logged as a warning and not ingested.
- Archived (`status=4`), full (`no_of_reply >= max_reply`, normally 1001) and suspended
  (`status=2`) threads are still re-scanned, because they can hold comments added before they
  closed. The script logs them as terminal.

### Logs

- Directory: `SCRAPE_LOG_DIR` (default `logs/scraper/`), gitignored.
- Files: `log_1.txt`, `log_2.txt`, ... A new number starts when the current file would pass
  `SCRAPE_LOG_MAX_BYTES` (default 10 MiB). Numbering continues across restarts.
- Format, one event per line:

```
[Info] 2026-10-25T03:00:00.000Z scrape run 12 created (source=LIHKG, log=...)
[Warning] 2026-10-25T03:00:12.000Z thread 4171247 is incomplete; ingesting the comments that were captured
[Error] 2026-10-25T03:00:20.000Z thread 4171247 page 5: timed out after 30000ms
```

- The active path is stored in `scrape_run.log_file` and returned by `GET /api/admin/scrape-runs`.

### Email alerts

- One summary email per run, sent only when the log contains at least one `[Error]`.
- Recipient: `ALERT_EMAIL_TO` (default `roy2b32@gmail.com`).
- SMTP settings come from `.env`; with an empty `SMTP_HOST` the run logs
  `[Warning] alert email not sent: SMTP is not configured` and continues.
- A failed send is a warning, never a second email.

### Scraper environment variables

| Variable | Default | Purpose |
| :-- | :-- | :-- |
| `SCRAPE_ENABLED` | `false` | Start the cron scheduler in this process |
| `SCRAPE_CRON` | `0 3 * * *` | Cron expression |
| `SCRAPE_TIMEZONE` | `Asia/Hong_Kong` | Cron timezone |
| `SCRAPE_RUN_ON_START` | `false` | Run once when the server starts |
| `SCRAPE_STALE_MINUTES` | `240` | Age after which a `running` row is treated as crashed |
| `SCRAPE_SOURCE` | `LIHKG` | `source.name` to scrape |
| `SCRAPE_KEYWORDS` | `劇` | Comma-separated keywords; each runs as its own scrape run |
| `SCRAPE_LIMIT` | `10` | Threads per run |
| `SCRAPE_SORT` | `desc_reply_time` | LIHKG search order; most recently replied threads first |
| `SCRAPE_DELAY_MS` | `4000` | Pause between page requests |
| `SCRAPE_TIMEOUT_MINUTES` | `180` | Hard limit for one run |
| `SCRAPE_INCLUDE_OP` | `false` | Store floor 1 as a comment |
| `SCRAPE_OUTPUT_DIR` | `scrape-output` | Raw JSON evidence per run, gitignored |
| `SCRAPE_LOG_DIR` | `logs/scraper` | Rotating text logs |
| `SCRAPE_LOG_MAX_BYTES` | `10485760` | Rotation threshold |
| `SMTP_HOST` | empty | SMTP server; empty disables email |
| `SMTP_PORT` | `587` | SMTP port |
| `SMTP_SECURE` | `false` | Use implicit TLS (port 465) |
| `SMTP_USER` / `SMTP_PASS` | empty | SMTP credentials |
| `ALERT_EMAIL_FROM` | `SMTP_USER` | Sender address |
| `ALERT_EMAIL_TO` | `roy2b32@gmail.com` | Alert recipient |

### Scraper limitations

- The scheduler lives in the API process. The server must stay running; Windows sleep or a stopped
  process skips the run. `npm run scrape` remains available for Task Scheduler.
- Overlap is enforced twice: the runner checks for a `running` row, and the database has a partial
  unique index that allows only one `running` row. Two API instances can both attempt a run, but the
  loser is rejected and logged as skipped.
- The guard is mechanical. A successful run means the pipeline completed, not that every comment on
  LIHKG was captured.
- Re-scraping terminal threads is intentional under the insert-only rule. It costs one full fetch
  per thread per run.
- `npm run build` compiles `src/` only. Keep `scripts/scrape/lihkg-keyword-pipeline.mjs` next to
  `dist/` when deploying (the runner resolves `../../scripts` from `dist/scraper`), and install
  Chromium on the host.

## Response envelope

Every JSON response uses one bean:

```json
{ "code": 200, "message": "OK", "data": { } }
```

- `code` is the HTTP status.
- Errors keep the status in `code`, `data` is `null`, and `message` is safe to show to visitors.
- The unavailable-comment 404 returns `data: { sourceUrl }` when the row exists but is hidden.
- `204` responses (`logout`, `delete`) have no body.

The four public read endpoints (`/api/comments`, `/api/comments/:id`, `/api/forums`,
`/api/threads/:threadId`) also repeat their payload fields at the top level. This is transitional:
the locked Playwright API tests read `body.comments`, `body.pagination` and `body.forums`. New code
reads `.data`; the aliases go away when those tests are re-frozen.

## Endpoints

### Public

| Method | Path | Data shape | Notes |
| :-- | :-- | :-- | :-- |
| `GET` | `/api/health` | `{ status, database }` | `503` when the database is down |
| `GET` | `/api/comments` | `{ comments, pagination }` | `page` (1), `pageSize` (20, max 100), `forumId`, `search` |
| `GET` | `/api/comments/:id` | `CommentSummary` | `404` with `data.sourceUrl` when hidden or removed |
| `GET` | `/api/forums` | `{ forums: [{ id, name, commentCount }] }` | Alphabetical, empty forums omitted |
| `GET` | `/api/threads/:threadId` | `{ thread, highlightedCommentId, comments, topLevel }` | `commentId`, `page` (1), `pageSize` (50) |
| `GET` | `/api/disclaimer` | `{ disclaimer }` | Project disclaimer text |

Behaviour: newest first; hidden comments and blocked authors are always excluded; an unknown
`forumId` means no filter; the thread tree re-parents replies around non-visible ancestors and
collapses branches below level 5.

### Admin (session cookie)

| Method | Path | Notes |
| :-- | :-- | :-- |
| `POST` | `/api/admin/login` | `{ username, password }`; `401`, `429` after 5 failures / 15 min / IP |
| `POST` | `/api/admin/logout` | `204`; `401` without a session |
| `GET` | `/api/admin/comments` | `q`, `author`, `source` (substring), `page`, `pageSize` (20); includes hidden and blocked rows, each with `author.id` |
| `PATCH` | `/api/admin/comments/:id/hidden` | `{ hidden }`; audits hide/unhide |
| `DELETE` | `/api/admin/comments/:id` | `204`; audits delete |
| `GET` | `/api/admin/authors` | `blocked=true` for the blocked list |
| `POST` | `/api/admin/authors/:id/block` | Idempotent; audits only on change |
| `POST` | `/api/admin/authors/:id/unblock` | Idempotent |
| `GET` | `/api/admin/actions` | `limit` (50); newest first |
| `GET` | `/api/admin/scrape-runs` | `limit` (20); newest first |

## Auth and security

- `fps_session` cookie: HttpOnly, SameSite=Lax, 30-minute inactivity expiry.
- Passwords are hashed with scrypt; a missing username still costs one comparison.
- Login failures are rate-limited per IP.
- Mutations reject a foreign `Origin` with `403`.
- Expired sessions are swept every 10 minutes.

## Disclaimer

This project does not aim to provide financial advice. Comments are public forum posts, not
investment recommendations. The statement is served at `GET /api/disclaimer` and repeated in the
frontend footer and About page.

## Project structure

```
src/
  server.ts              process entry: config, pool, listen, graceful shutdown
  app.ts                 buildApp(): plugins, guards, error handler, routes
  config.ts              environment parsing
  db.ts                  pg pool behind a small Database interface
  http-error.ts          HttpError + error response
  http-response.ts       success() and withLegacy()
  types/
    request/               *.request.ts   route params, query and body shapes
    response/              *.response.ts  API response shapes and the envelope
    data/                  *.data.ts      database row and tree shapes
  repository/            data access, one file per aggregate
    commentRepository.ts   public comments, excerpt, unknown-forum fallback
    threadRepository.ts    thread header + paginated visible tree
    adminRepository.ts     moderation queries and audit writes
    scrapeRepository.ts    scrape_run lifecycle, stale detection, source lookup
    ingestRepository.ts    thread/author/comment upserts, parents, source-removed hiding
  comments/              public comment routes
  forums/                sidebar routes
  threads/               tree builder and thread route
  auth/                  password hashing, sessions, rate limit, guard, login routes
  admin/                 moderation routes
  health/                health check
  scraper/
    scheduler.ts           node-cron registration, run-on-start, graceful stop
    runner.ts              spawns the pipeline, streams events, ingests, emails
    log-writer.ts          log_{n}.txt formatting and 10 MiB rotation
    events.ts              NDJSON/plain event parser
    notifier.ts            one summary email per failed run
    html.ts                LIHKG HTML to plain text, language detection
    cli.ts                 npm run scrape
scripts/
  scrape/lihkg-keyword-pipeline.mjs  Playwright LIHKG search + thread scraper
test/
  app.test.ts            route tests with an in-memory repository
  scraper/               log writer, event parser, notifier, runner
  integration/           real database tests: tree, auth, moderation, audit, ingestion
```

## Testing

```bash
# once after pulling the scraper change: adds scrape_run.log_file/error_count/stop_reason
cd ../find-potential-stock/local-env && npm run db:setup

# reseed first: the Playwright admin tests mutate rows
npm run db:reset && cd ../../find-potential-stock-backend
npm test
```

The integration tests skip themselves when PostgreSQL is unreachable; the unit tests still run. The
scraper tests never call LIHKG: `test/fixtures/fake-scrape.mjs` stands in for the real pipeline.

## Schema and limits

- `../find-potential-stock/local-env/database/sql/schema.sql` is idempotent and applied by
  `npm run db:setup`.
- No migration history yet; add one before the first production deploy.
- Login rate limiting is in memory, correct for one process, not for multiple instances.
