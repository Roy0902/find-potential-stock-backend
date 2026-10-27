# Full TypeORM Migration Plan

## Goal

Replace the current TypeORM-backed raw-SQL adapter with real TypeORM entities and repositories. Preserve the existing Fastify routes, API response shapes, PostgreSQL-specific batch ingestion behavior, and per-thread transaction boundary.

The sibling `local-env` schema is the source of truth. Do not infer a deployable schema from backend queries, and keep `synchronize: false`.

## Phase 1: Schema Baseline

1. [x] Obtain `local-env/database/sql/schema.sql` and its seed/setup scripts.
2. [x] Apply the schema to an empty local database and verify the live catalog: 11 tables, 73 columns, 38 constraints, and 27 indexes. Confirmed `pg_trgm` 1.6, foreign-key delete rules, and the partial unique `scrape_run_one_running_ix`.
3. [x] Migration ownership: TypeORM owns future backend migrations; `local-env` remains the setup and deterministic seed entry point. Keep `synchronize: false`.

## Phase 2: TypeORM Bootstrap and Entities

1. Replace the custom database adapter with `src/database/data-source.ts` containing the TypeORM `DataSource`, PostgreSQL pool settings, logging policy, migration registration, and shutdown helpers.
2. Add verified entities under `src/database/entities/`: `Source`, `Thread`, `Author`, `Comment`, `Stock`, `StockAlias`, `CommentStock`, `ScrapeRun`, `OwnerAccount`, `OwnerSession`, and `AdminAction`.
3. Map snake_case columns, nullable parent comments, timestamps, hidden state, composite uniqueness, and relationships explicitly.
4. Add a verified baseline/future migration strategy. Never enable TypeORM synchronization against local or production databases.

## Phase 3: Repository Conversion

1. Update `src/server.ts`, `src/scraper/cli.ts`, and `src/app.ts` to initialize one DataSource and inject TypeORM repositories/entity managers.
2. Convert ordinary CRUD and read paths in the comment, thread, admin, scrape, authentication, and session modules.
3. Use TypeORM repositories for simple CRUD and QueryBuilder for joins, filtering, pagination, and PostgreSQL search.
4. Convert ingestion last. Use a transaction-scoped manager while preserving 500-row batch inserts, `ON CONFLICT`, `RETURNING`, parent resolution, `last_seen_at`, `source_removed` hiding/recovery, restricted rows, and rollback behavior.
5. Keep parameterized raw SQL where entity `save()` would create N+1 queries or reduce PostgreSQL control.
6. Remove the obsolete custom query adapter and stale duplicate imports/files.

## Phase 4: Tests and Setup

1. Update the app test dependency boundary while retaining route-level fake repository tests.
2. Update API and scrape integration tests to use the verified schema/migrations and seed data.
3. Add tests for entity mapping, rollback, batch conflict handling, composite uniqueness, parent resolution, hidden-comment recovery, and single-running scrape behavior.
4. Keep scraper unit tests independent of the database.

## Phase 5: Verification

1. Confirm the local-env schema and live catalog match.
2. Run `npm run typecheck` and `npm run build` after each phase.
3. Run focused entity, repository, rollback, and batch tests.
4. Run all unit and integration tests against a freshly migrated and seeded disposable database.
5. Compare generated SQL, affected-row counts, and `EXPLAIN` plans for comment search and ingestion.
6. Verify server startup/shutdown, degraded database health, scraper cleanup, and scheduler behavior.

## Decisions

- Full TypeORM migration, not merely a TypeORM wrapper around raw SQL.
- External `local-env` schema is authoritative.
- `synchronize` remains disabled.
- Existing API contracts and transaction boundaries remain stable.
- Raw SQL or QueryBuilder remains allowed for high-volume PostgreSQL ingestion.
- Entity cascades and lazy relations require explicit performance and deletion tests.

## Status (2026-10-27)

Phase 1 is complete. `local-env` is present, and its schema/setup and deterministic seed scripts were exercised against PostgreSQL 17.11. The database was empty before setup.

Phases 2-5 remain. The backend currently uses TypeORM `DataSource` as a raw-query adapter; it has no registered entities or migrations. Build entities/migrations from the verified schema baseline, not inferred queries.

Validation environment issue: backend `.env` connects as `fps_local_7c4a9e`, while `local-env/.env` connects as `postgres`. The schema objects created by `db:setup` are owned by `postgres`, so integration requests using the backend role receive `permission denied` until credentials are aligned or deliberate least-privilege grants are applied.
