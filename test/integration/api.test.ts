import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { PostgresCommentRepository } from '../../src/repository/comment.repository.js';
import { createDatabase, type Database } from '../../src/database/db.js';

const config = loadConfig();
const db: Database = createDatabase(config);
const app: FastifyInstance = await buildApp({
  config,
  db,
  repository: new PostgresCommentRepository(db),
  logger: false,
});
const dbUp = await db.isAvailable();

const FIXTURE = { source: 9950, thread: 9950, author: 9950, comment: 9950 };

async function cleanupFixture() {
  await db.query('DELETE FROM comment WHERE source_id = $1', [FIXTURE.source]);
  await db.query('DELETE FROM thread WHERE source_id = $1', [FIXTURE.source]);
  await db.query('DELETE FROM author WHERE source_id = $1', [FIXTURE.source]);
  await db.query('DELETE FROM source WHERE id = $1', [FIXTURE.source]);
  // admin_action has no foreign key, so fixture targets are cleared explicitly.
  await db.query(
    `DELETE FROM admin_action
      WHERE (target_type = 'comment' AND target_id = $1)
         OR (target_type = 'author' AND target_id = $2)`,
    [FIXTURE.comment, FIXTURE.author],
  );
}

async function seedFixture() {
  await cleanupFixture();
  await db.query(
    "INSERT INTO source (id, name, base_url, enabled) VALUES ($1, 'Fixture', 'https://fixture.test', false)",
    [FIXTURE.source],
  );
  await db.query(
    "INSERT INTO thread (id, source_id, external_id, title, url, first_seen_at) VALUES ($1, $1, 't', 'Fixture thread', 'https://fixture.test/t', now())",
    [FIXTURE.thread],
  );
  await db.query(
    "INSERT INTO author (id, source_id, external_id, display_name) VALUES ($1, $1, 'a', 'Fixture Author')",
    [FIXTURE.author],
  );
  await db.query(
    `INSERT INTO comment (id, source_id, thread_id, author_id, external_id, body, posted_at, url, first_seen_at, last_seen_at)
     VALUES ($1, $2, $2, $2, 'fixture-c', 'Fixture comment body', '2026-10-01T00:00:00Z', 'https://fixture.test/c/1', now(), now())`,
    [FIXTURE.comment, FIXTURE.source],
  );
}

async function login(remoteAddress = '127.0.0.1'): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/admin/login',
    payload: { username: 'owner', password: 'change-me' },
    remoteAddress,
  });
  assert.equal(response.statusCode, 200);
  return String(response.headers['set-cookie']).split(';')[0]!;
}

async function countAudit(targetType: string, targetId: number): Promise<number> {
  const result = await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM admin_action WHERE target_type = $1 AND target_id = $2',
    [targetType, targetId],
  );
  return result.rows[0]!.n;
}

after(async () => {
  await cleanupFixture();
  await app.close();
  await db.end();
});

describe('backend integration', { skip: !dbUp ? 'database unavailable' : false }, () => {
  describe('public read', () => {
    test('thread tree hides non-visible comments and caps depth', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/threads/1001' });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.data.thread.title, '美股討論區（AAPL / NVDA / TSLA）');

      type Node = {
        id: number;
        depth: number;
        collapsed: boolean;
        parentMissing: boolean;
        replyTargetUnknown: boolean;
        children: Node[];
      };
      const flat: Node[] = [];
      const walk = (nodes: Node[]) => {
        for (const node of nodes) {
          flat.push(node);
          walk(node.children);
        }
      };
      walk(body.data.comments as Node[]);

      const ids = flat.map((node) => node.id);
      assert.ok(ids.includes(5001));
      assert.ok(!ids.includes(5004), 'blocked author comment must be removed');
      assert.ok(!ids.includes(5013), 'hidden comment must be removed');
      assert.ok(!ids.includes(5008), 'level 6 must be collapsed');

      assert.equal(flat.find((node) => node.id === 5010)?.parentMissing, true);
      assert.equal(flat.find((node) => node.id === 5011)?.replyTargetUnknown, true);
      assert.equal(flat.find((node) => node.id === 5007)?.collapsed, true);
    });

    test('thread pages hold 50 top-level comments', async () => {
      const first = (await app.inject({ method: 'GET', url: '/api/threads/1002' })).json();
      assert.equal(first.data.comments.length, 50);
      assert.equal(first.data.topLevel.total, 55);

      const second = (
        await app.inject({ method: 'GET', url: '/api/threads/1002?page=2' })
      ).json();
      assert.equal(second.data.comments.length, 5);
    });

    test('an unknown thread returns 404', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/threads/999999' });
      assert.equal(response.statusCode, 404);
      assert.equal(response.json().message, 'Thread not found.');
    });

    test('an unknown forum id means no filter', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/comments?forumId=999' });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().data.pagination.total, 71);
    });

    test('a hidden comment returns 404 with its source URL', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/comments/5013' });
      assert.equal(response.statusCode, 404);
      assert.equal(response.json().message, 'This comment is no longer available.');
      assert.match(response.json().data.sourceUrl, /#lihkg-c-5013$/);
    });

    test('a visible comment keeps its public shape', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/comments/5001' });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.data.author.displayName, '股壇新手');
      assert.equal(body.data.author.externalId, 'u2001');
      assert.equal([...body.data.excerpt].length <= 200, true);
    });
  });

  describe('authentication', () => {
    test('admin routes reject requests without a session', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/comments' });
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().message, 'Sign in required.');
    });

    test('a wrong password is rejected', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/login',
        payload: { username: 'owner', password: 'wrong' },
        remoteAddress: '10.0.0.1',
      });
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().message, 'Invalid username or password.');
    });

    test('the sixth failed login is throttled', async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/admin/login',
          payload: { username: 'owner', password: 'wrong' },
          remoteAddress: '10.0.0.2',
        });
        assert.equal(response.statusCode, 401);
      }
      const blocked = await app.inject({
        method: 'POST',
        url: '/api/admin/login',
        payload: { username: 'owner', password: 'wrong' },
        remoteAddress: '10.0.0.2',
      });
      assert.equal(blocked.statusCode, 429);
      assert.equal(blocked.json().message, 'Too many attempts. Try again later.');
    });

    test('a successful login yields a session and admin rows carry author ids', async () => {
      const cookie = await login();
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/comments?pageSize=1',
        headers: { cookie },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(typeof response.json().data.comments[0].author.id, 'number');
    });

    test('an idle session expires', async () => {
      const cookie = await login();
      const token = cookie.split('=')[1];
      await db.query(
        "UPDATE owner_session SET last_seen_at = now() - interval '31 minutes' WHERE token = $1",
        [token],
      );
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/comments',
        headers: { cookie },
      });
      assert.equal(response.statusCode, 401);
    });

    test('logout ends the session and requires one', async () => {
      const cookie = await login();
      const logout = await app.inject({
        method: 'POST',
        url: '/api/admin/logout',
        headers: { cookie },
      });
      assert.equal(logout.statusCode, 204);

      const afterLogout = await app.inject({
        method: 'GET',
        url: '/api/admin/comments',
        headers: { cookie },
      });
      assert.equal(afterLogout.statusCode, 401);

      const anonymous = await app.inject({ method: 'POST', url: '/api/admin/logout' });
      assert.equal(anonymous.statusCode, 401);
    });

    test('a foreign Origin is rejected on mutations', async () => {
      await seedFixture();
      const cookie = await login();
      const rejected = await app.inject({
        method: 'PATCH',
        url: `/api/admin/comments/${FIXTURE.comment}/hidden`,
        headers: { cookie, origin: 'https://evil.test' },
        payload: { hidden: true },
      });
      assert.equal(rejected.statusCode, 403);
      assert.equal(rejected.json().message, 'Origin not allowed.');

      const allowed = await app.inject({
        method: 'PATCH',
        url: `/api/admin/comments/${FIXTURE.comment}/hidden`,
        headers: { cookie, origin: 'http://localhost:5173' },
        payload: { hidden: false },
      });
      assert.equal(allowed.statusCode, 200);
    });
  });

  describe('moderation', () => {
    test('hide and unhide keep the row and write two audit entries', async () => {
      await seedFixture();
      const cookie = await login();
      const before = await countAudit('comment', FIXTURE.comment);

      const hide = await app.inject({
        method: 'PATCH',
        url: `/api/admin/comments/${FIXTURE.comment}/hidden`,
        headers: { cookie },
        payload: { hidden: true },
      });
      assert.equal(hide.statusCode, 200);
      assert.equal(hide.json().data.isHidden, true);

      const hidden = await app.inject({
        method: 'GET',
        url: `/api/comments/${FIXTURE.comment}`,
      });
      assert.equal(hidden.statusCode, 404);

      const unhide = await app.inject({
        method: 'PATCH',
        url: `/api/admin/comments/${FIXTURE.comment}/hidden`,
        headers: { cookie },
        payload: { hidden: false },
      });
      assert.equal(unhide.statusCode, 200);
      assert.equal(await countAudit('comment', FIXTURE.comment), before + 2);
    });

    test('delete removes the row and keeps the audit entry', async () => {
      await seedFixture();
      const cookie = await login();
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/admin/comments/${FIXTURE.comment}`,
        headers: { cookie },
      });
      assert.equal(response.statusCode, 204);
      assert.equal(await countAudit('comment', FIXTURE.comment), 1);

      const gone = await app.inject({ method: 'GET', url: `/api/comments/${FIXTURE.comment}` });
      assert.equal(gone.statusCode, 404);
      assert.equal(gone.json().data.sourceUrl, null);
    });

    test('blocking is idempotent and audited once', async () => {
      await seedFixture();
      const cookie = await login();
      const first = await app.inject({
        method: 'POST',
        url: `/api/admin/authors/${FIXTURE.author}/block`,
        headers: { cookie },
      });
      assert.equal(first.json().data.changed, true);

      const second = await app.inject({
        method: 'POST',
        url: `/api/admin/authors/${FIXTURE.author}/block`,
        headers: { cookie },
      });
      assert.equal(second.json().data.changed, false);
      assert.equal(await countAudit('author', FIXTURE.author), 1);

      const unblock = await app.inject({
        method: 'POST',
        url: `/api/admin/authors/${FIXTURE.author}/unblock`,
        headers: { cookie },
      });
      assert.equal(unblock.json().data.changed, true);
      assert.equal(await countAudit('author', FIXTURE.author), 2);
    });

    test('the admin source filter matches substrings', async () => {
      const cookie = await login();
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/comments?source=HKGo&pageSize=100',
        headers: { cookie },
      });
      assert.equal(response.statusCode, 200);
      const rows = response.json().data.comments;
      assert.ok(rows.length > 0);
      assert.ok(rows.every((row: { sourceName: string }) => row.sourceName === 'HKGolden'));
    });

    test('collection status lists the seeded runs', async () => {
      const cookie = await login();
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/scrape-runs',
        headers: { cookie },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().data.runs.length, 2);
    });
  });
});
