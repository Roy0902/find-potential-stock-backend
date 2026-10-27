# Scraper review follow-ups

Status: **review complete; targeted scraper verification green; full verification incomplete**.
Both immediate scraper blockers are fixed. The latest backend typecheck and build pass, and the
focused scrape integration tests pass 10/10. The full-suite and Playwright caveats are recorded below.

Keep `SCRAPE_ENABLED=false` until the backend database role is configured for the local schema and
the full Playwright suite passes with its hard-coded `localhost:3000` request reaching this backend.

## Resolved Blockers

### 1. Deleted-only runs are misclassified as a layout failure

**File:** `src/scraper/runner.ts:580`

Current code:

```ts
if (seen === 0) {
  const message = 'all thread files contained 0 comments; possible layout change';
  errors.push(message);
  await writer.write('error', message);
}
```

A deleted thread (`response.status === 3`) is now handled by hiding its stored comments and
`continue`-ing, so `seen` stays 0. That is expected, but this block turns the run into `failed`
instead of `success`. The all-zero error must only fire when at least one non-deleted thread was
actually ingested.

Fix:

```ts
if (seen === 0 && ingestedThreads > 0) {
  const message = 'all thread files contained 0 comments; possible layout change';
  errors.push(message);
  await writer.write('error', message);
}
```

`ingestedThreads` is already incremented at `src/scraper/runner.ts:556`.

Resolved: the guard requires `ingestedThreads > 0`. The test `does not ingest a deleted thread` passes.

### 2. Skip test still reads a log file that skipped runs no longer write

**File:** `test/scraper/runner.test.ts:199`

Current test:

```ts
assert.match(await readFile(result.logFile!, 'utf8'), /skipping this run/);
```

Skipped runs now return `logFile: null` and log the skip through `console.warn` instead of touching
the active run's log. Replace the line with:

```ts
assert.equal(result.logFile, null);
```

Resolved: the test asserts `result.logFile === null`. The skip test passes.

## Verification Record (2026-10-27)

- Backend typecheck and build pass after the raw-message storage change.
- Focused scraper ingestion integration tests pass 10/10, and runner tests pass 7/7 with title-bearing filename support.
- The latest full `npm test` run passed 65/69. Four API integration tests failed because their shared database fixtures were not in the expected clean state; do not treat that run as a green full-suite result.
- The follow-up Playwright suite previously passed 48/49 on isolated ports. Locked scenario `SCN-followup-020` hard-codes `http://localhost:3000/api/threads/9960`, where an unrelated Vite process was listening and returned HTML. The locked test was not edited.
- `npm run ai:verify` passed all five frozen feature sets in the earlier verification run.

Note: `SCN-followup-021` can fail when run alone because the locked test calls `evaluateAll`
immediately after `domcontentloaded` without waiting for the card list. The full 49-test suite is the
acceptance run; do not edit the locked test.

## Review findings and current status

### Fixed in the working tree

| ID | Item |
| :-- | :-- |
| C1 | Completeness now requires a valid `total_page` and every declared page captured; the importer also requires matching `pages_expected`/`pages_captured` before hiding. |
| H1 | `skipped()` no longer clears the active run's `running` flag. |
| H2 | Shutdown waits on the run's idle promise; child is killed as a process tree; abort is rechecked after spawn. |
| H3 | Error email is sent even when the failure happens before a `scrape_run` row exists (`ErrorReport.id` is nullable). |
| H4 | `SCRAPE_STALE_MINUTES` defaults to 240 and must exceed `SCRAPE_TIMEOUT_MINUTES + 5`; hiding is run-scoped with `last_seen_at < runStartedAt`. |
| M1 | A `source_removed` comment that reappears is unhidden; `admin` stays hidden. |
| M2 | Items present but unparseable are excluded from the hide UPDATE via `presentIds`. |
| M3 | HTML entity decoding clamps invalid code points and strips NULs. |
| M4 | Per-event log-write failures are collected; run status/email reflect them. |
| M5 | `LogWriter.init()` no longer rotates; skipped runs do not write into the active log; dry runs use `logs/scraper/dry/`. |
| M6 | Cron callback returns the run promise so `noOverlap` works. |
| M7 | Invalid cron/timezone logs an error and disables the scraper instead of taking down the API. |
| M8 | `taskkill /T /F` on Windows and process-group kill on POSIX. |
| M9 | Missing output files and all-zero comment files are errors (blocker 1 above is the remaining edge). |
| M10 | `scrape_run.log_file` and the email point at the first log file of the run. |
| M11 | A deleted source thread hides its stored comments as `source_removed`. |
| M12 | Integration cleanup refuses to delete a non-fixture source. |
| M14 | Disabled sources are not scraped. |
| M15 | `readdir` failures other than `ENOENT` propagate. |
| Low 2 | Lone `\r` is handled by `[\r\n]+`. |
| Low 3 | Log messages are truncated to 8 KiB. |
| Low 5 | `error_count` uses `max(writer.errorCount, errorMessages.length)`. |
| Low 6 | A keyword starting with `-` is rejected. |
| Low 8 | `schema.sql` closes pre-existing `running` rows before creating the unique index. |
| Low 9 | Pool sets `statement_timeout: 30_000`. |

### Still open

| ID | Item | Suggested fix |
| :-- | :-- | :-- |
| M11b | `DELETE /api/admin/comments/:id` is a hard delete; the next scrape re-inserts the comment. | Tombstone table or soft delete; `ingestThread` skips tombstoned external ids. |
| M13 | No retention for `scrape-output/run-*`; each daily run keeps every JSON forever. | Add `SCRAPE_OUTPUT_RETENTION_DAYS` and prune old `run-*` dirs after a successful ingest. |
| Low 1 | `boolFromEnv` accepts only lowercase `true`/`1`; `intFromEnv` allows 0 for limit/timeout/stale. | Normalize booleans; validate minimums. |
| Low 10 | CLI has no SIGINT/SIGTERM handler; Ctrl+C leaves a `running` row until the stale sweep. | Add handlers that call `runner.stop()` and close the DB. |
| Low 11 | Missing tests: empty-complete guard, reappearing `source_removed`, shutdown, single-running index (runner-level), strict `last_seen_at > before`. | Add to `test/scraper/runner.test.ts` and `test/integration/scrape.test.ts`. |
| Low 12 | `scrape_run.log_file` is an absolute server path returned by the admin API. | Store a relative path or log id. |
| Low 13 | Only the first `SCRAPE_KEYWORDS` entry is used. | Loop keywords or document explicitly. |
| Low 15 | Pipeline keeps every captured page and rewrites the whole thread file per page. | Clear `captured` per thread; write once at the end. |
| Low 16 | `state.json` is per-run, so `completed` tracking is dead. | Persist a stable state file or remove the field. |

## Working-tree notes

- The branch contains the scraper HTML-filter commit and its published revert. Current worktree intent is to preserve original `msg` strings; do not rewrite the shared history without coordinating a force push.
- The backend `.env` uses role `fps_local_7c4a9e`, while `local-env/.env` uses `postgres`. Tables created by `db:setup` are owned by `postgres`; align credentials or apply deliberate least-privilege grants before running the API against this database.
- `logs/scraper/` and `scrape-output/` are gitignored. Manual-run evidence from the earlier real
  scrape is still present there.
- The real `.env` has `SCRAPE_ENABLED=false` and empty SMTP settings. Fill `SMTP_HOST`, `SMTP_PORT`,
  `SMTP_USER`, `SMTP_PASS` and `ALERT_EMAIL_FROM` before testing email delivery.
- `scripts/scrape/lihkg-keyword-pipeline.mjs` must stay next to `dist/` when deploying; `npm run
  build` compiles `src/` only.
