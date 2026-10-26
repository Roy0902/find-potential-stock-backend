# Full TypeORM Migration Plan

## Goal

Replace the current TypeORM-backed raw-SQL adapter with real TypeORM entities and repositories. Preserve the existing Fastify routes, API response shapes, PostgreSQL-specific batch ingestion behavior, and per-thread transaction boundary.

The external `find-potential-stock/local-env` schema is the source of truth. Do not infer a deployable schema from backend queries, and keep `synchronize: false`.

## Phase 1: Schema Baseline

1. Obtain `../find-potential-stock/local-env/database/sql/schema.sql` and its seed/setup scripts.
2. Verify tables, column types, nullability, defaults, primary/foreign keys, unique constraints, indexes, the partial unique running-scrape constraint, `pg_trgm`, and delete/update rules against PostgreSQL.
3. Decide migration ownership. Recommended: TypeORM owns future backend migrations; `local-env` remains the setup and deterministic seed entry point.

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

## Current Blocker

The external `local-env` schema and seed project are on another computer. Entity mapping and migration generation must wait until those files or a populated database are available.
