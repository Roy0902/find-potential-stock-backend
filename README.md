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
  comments/              public comment routes
  forums/                sidebar routes
  threads/               tree builder and thread route
  auth/                  password hashing, sessions, rate limit, guard, login routes
  admin/                 moderation routes
  health/                health check
test/
  app.test.ts            route tests with an in-memory repository
  integration/           real database tests: tree, auth, moderation, audit
```

## Testing

```bash
# reseed first: the Playwright admin tests mutate rows
cd ../find-potential-stock/local-env && npm run db:reset && cd ../../find-potential-stock-backend
npm test
```

The integration tests skip themselves when PostgreSQL is unreachable; the unit tests still run.

## Schema and limits

- `../find-potential-stock/local-env/database/sql/schema.sql` is idempotent and applied by
  `npm run db:setup`.
- No migration history yet; add one before the first production deploy.
- Login rate limiting is in memory, correct for one process, not for multiple instances.
