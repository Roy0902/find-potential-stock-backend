import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { CommentSummary } from '../src/types/response/comments.response.js';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/db.js';
import { FakeCommentRepository, fakeComment } from './helpers/fake-repository.js';

function fakeDb(available: boolean): Database {
  return {
    query: async () => {
      throw new Error('fake database: query not expected in these tests');
    },
    transaction: async () => {
      throw new Error('fake database: transaction not expected in these tests');
    },
    end: async () => undefined,
    isAvailable: async () => available,
  };
}

function build(repository = new FakeCommentRepository()) {
  return buildApp({
    config: loadConfig({}),
    db: fakeDb(true),
    repository,
    logger: false,
  });
}

describe('health', () => {
  test('reports ok when the database is reachable', async () => {
    const app = await build();
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      code: 200,
      message: 'OK',
      data: { status: 'ok', database: 'up' },
    });
    await app.close();
  });

  test('reports degraded when the database is down', async () => {
    const app = await buildApp({
      config: loadConfig({}),
      db: fakeDb(false),
      repository: new FakeCommentRepository(),
      logger: false,
    });
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), {
      code: 503,
      message: 'Degraded',
      data: { status: 'degraded', database: 'down' },
    });
    await app.close();
  });
});

describe('GET /api/comments', () => {
  let app: FastifyInstance;

  before(async () => {
    const comments = [
      fakeComment({ id: 1, postedAt: '2026-10-01T00:10:00.000Z', body: '今日 $AAPL 破頂' }),
      fakeComment({ id: 2, postedAt: '2026-10-01T00:20:00.000Z', body: 'Nvidia 好強' }),
      fakeComment({ id: 3, postedAt: '2026-10-01T00:30:00.000Z', sourceId: 2, sourceName: 'HKGolden' }),
    ];
    app = await build(
      new FakeCommentRepository(comments, [
        { id: 1, name: 'LIHKG' },
        { id: 2, name: 'HKGolden' },
      ]),
    );
  });

  after(async () => {
    await app.close();
  });

  test('returns newest first with default pagination of 20', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/comments' });
    assert.equal(response.statusCode, 200);

    const body = response.json();
    assert.equal(body.code, 200);
    assert.equal(body.message, 'OK');
    assert.deepEqual(
      body.data.comments.map((comment: { id: number }) => comment.id),
      [3, 2, 1],
    );
    assert.deepEqual(body.data.pagination, { page: 1, pageSize: 20, total: 3, totalPages: 1 });
  });

  test('truncates the excerpt at 200 characters', async () => {
    const longBody = '字'.repeat(250);
    const longApp = await build(
      new FakeCommentRepository([fakeComment({ id: 9, body: longBody })]),
    );
    const response = await longApp.inject({ method: 'GET', url: '/api/comments' });

    const [comment] = response.json().data.comments;
    assert.equal(comment.body, longBody);
    assert.equal([...comment.excerpt].length, 200);
    await longApp.close();
  });

  test('filters by forum', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/comments?forumId=2' });
    const body = response.json();
    assert.deepEqual(
      body.data.comments.map((comment: { id: number }) => comment.id),
      [3],
    );
    assert.equal(body.data.pagination.total, 1);
  });

  test('filters by keyword', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/comments?search=nvidia' });
    const body = response.json();
    assert.deepEqual(
      body.data.comments.map((comment: { id: number }) => comment.id),
      [2],
    );
  });

  test('returns an empty page when nothing matches', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/comments?search=zzz' });
    const body = response.json();
    assert.deepEqual(body.data.comments, []);
    assert.equal(body.data.pagination.total, 0);
    assert.equal(body.data.pagination.totalPages, 0);
  });

  test('rejects a page size above the maximum', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/comments?pageSize=101' });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, 400);
    assert.equal(response.json().data, null);
  });

  test('ignores unknown query parameters', async () => {
    // Fastify strips undeclared query keys before validation.
    const response = await app.inject({ method: 'GET', url: '/api/comments?unknown=1' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.pagination.total, 3);
  });

  test('treats a blank search term as no filter', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/comments?search=%20' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.pagination.total, 3);
  });
});

describe('GET /api/comments/:id', () => {
  test('returns the comment when it exists', async () => {
    const app = await build(new FakeCommentRepository([fakeComment({ id: 7 })]));
    const response = await app.inject({ method: 'GET', url: '/api/comments/7' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.id, 7);
    await app.close();
  });

  test('returns the not-available message when missing', async () => {
    const app = await build(new FakeCommentRepository());
    const response = await app.inject({ method: 'GET', url: '/api/comments/999' });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), {
      code: 404,
      message: 'This comment is no longer available.',
      data: { sourceUrl: null },
    });
    await app.close();
  });

  test('returns the stored source URL when the comment is not publicly visible', async () => {
    class HiddenCommentRepository extends FakeCommentRepository {
      override async getCommentById(): Promise<CommentSummary | null> {
        return null;
      }
    }
    const sourceUrl = 'https://lihkg.com/thread/1001/page/1#comment';
    const app = await build(
      new HiddenCommentRepository([fakeComment({ id: 5013, url: sourceUrl })]),
    );
    const response = await app.inject({ method: 'GET', url: '/api/comments/5013' });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), {
      code: 404,
      message: 'This comment is no longer available.',
      data: { sourceUrl },
    });
    await app.close();
  });

  test('rejects a non-numeric id', async () => {
    const app = await build();
    const response = await app.inject({ method: 'GET', url: '/api/comments/abc' });
    assert.equal(response.statusCode, 400);
    await app.close();
  });
});

describe('GET /api/forums', () => {
  test('lists only forums with visible comments, alphabetical, with counts', async () => {
    const app = await build(
      new FakeCommentRepository(
        [
          fakeComment({ id: 1, sourceId: 1, sourceName: 'LIHKG' }),
          fakeComment({ id: 2, sourceId: 1, sourceName: 'LIHKG' }),
        ],
        [
          { id: 1, name: 'LIHKG' },
          { id: 2, name: 'HKGolden' },
        ],
      ),
    );
    const response = await app.inject({ method: 'GET', url: '/api/forums' });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.code, 200);
    assert.equal(body.message, 'OK');
    assert.deepEqual(body.data, {
      forums: [{ id: 1, name: 'LIHKG', commentCount: 2 }],
    });
    await app.close();
  });
});

describe('GET /api/disclaimer', () => {
  test('returns the project disclaimer', async () => {
    const app = await build();
    const response = await app.inject({ method: 'GET', url: '/api/disclaimer' });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().data.disclaimer, /does not aim to provide financial advice/);
    await app.close();
  });
});

describe('unknown route', () => {
  test('returns a 404 envelope', async () => {
    const app = await build();
    const response = await app.inject({ method: 'GET', url: '/api/nope' });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, 404);
    assert.equal(response.json().data, null);
    await app.close();
  });
});
