import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { Database } from '../../src/database/db.js';
import { HttpError } from '../../src/http/http-error.js';
import type { ScrapeIngestApi } from '../../src/scraper/ingest.service.js';
import type { LihkgThreadFile, ScrapeRunProgress } from '../../src/types/data/scrape.data.js';
import { FakeCommentRepository } from '../helpers/fake-repository.js';

function fakeDb(): Database {
  return {
    query: async () => {
      throw new Error('fake database: query not expected in these tests');
    },
    transaction: async () => {
      throw new Error('fake database: transaction not expected in these tests');
    },
    end: async () => undefined,
    isAvailable: async () => true,
  };
}

function progress(overrides: Partial<ScrapeRunProgress> = {}): ScrapeRunProgress {
  return {
    runId: 12,
    status: 'running',
    stopReason: null,
    startedAt: '2026-11-03T00:00:00.000Z',
    finishedAt: null,
    keyword: '劇',
    maxThreads: 10,
    stopOnComplete: false,
    threadsProcessed: 0,
    commentsAdded: 0,
    commentsSkippedRestricted: 0,
    errorCount: 0,
    ...overrides,
  };
}

const THREAD: LihkgThreadFile = {
  success: 1,
  response: {
    thread_id: 900001,
    title: 'Fixture',
    status: 1,
    no_of_reply: 1,
    total_page: 1,
    item_data: [],
  },
};

function fakeApi(overrides: Partial<ScrapeIngestApi> = {}): ScrapeIngestApi {
  return {
    async start() {
      return progress();
    },
    async ingestThread(runId) {
      return {
        action: 'continue',
        stopReason: null,
        thread: {
          threadId: 5,
          externalThreadId: '900001',
          added: 1,
          seen: 1,
          skippedRestricted: 0,
          hidden: 0,
        },
        error: null,
        run: progress({ runId, threadsProcessed: 1, commentsAdded: 1 }),
      };
    },
    async finish(runId) {
      return {
        run: progress({ runId, status: 'success', stopReason: 'exhausted' }),
        alreadyFinished: false,
      };
    },
    async getRun(runId) {
      return progress({ runId });
    },
    async getActive() {
      return null;
    },
    ...overrides,
  };
}

function build(options: { token?: string; service?: ScrapeIngestApi } = {}) {
  const config = loadConfig({ SCRAPE_INGEST_TOKEN: options.token ?? 'secret' });
  return buildApp({
    config,
    db: fakeDb(),
    repository: new FakeCommentRepository(),
    logger: false,
    scrapeIngest: options.service ?? fakeApi(),
  });
}

const AUTH = { 'x-scrape-token': 'secret' };

describe('scrape ingest auth', () => {
  test('rejects a request without the token header', async () => {
    const app = await build();
    const response = await app.inject({ method: 'POST', url: '/api/scrape/runs', payload: {} });

    assert.equal(response.statusCode, 401);
    assert.equal(response.json().message, 'A valid scraping ingest token is required.');
    await app.close();
  });

  test('rejects a wrong token', async () => {
    const app = await build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/scrape/runs',
      headers: { 'x-scrape-token': 'nope' },
      payload: {},
    });

    assert.equal(response.statusCode, 401);
    await app.close();
  });

  test('is disabled when SCRAPE_INGEST_TOKEN is empty', async () => {
    const app = await build({ token: '' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/scrape/runs',
      headers: AUTH,
      payload: {},
    });

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().message, 'SCRAPE_INGEST_TOKEN is not configured on this server.');
    await app.close();
  });

  test('accepts the configured token', async () => {
    const app = await build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/scrape/runs',
      headers: AUTH,
      payload: { keyword: '劇', limit: 2 },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.runId, 12);
    await app.close();
  });
});

describe('scrape ingest endpoints', () => {
  test('start forwards the body to the service', async () => {
    let received: unknown = null;
    const service = fakeApi({
      async start(input) {
        received = input;
        return progress();
      },
    });
    const app = await build({ service });

    await app.inject({
      method: 'POST',
      url: '/api/scrape/runs',
      headers: AUTH,
      payload: { mode: 'backfill', keyword: '美股', limit: 3, stopOnComplete: true },
    });

    assert.deepEqual(received, {
      mode: 'backfill',
      keyword: '美股',
      limit: 3,
      stopOnComplete: true,
    });
    await app.close();
  });

  test('rejects a body that is not a thread file', async () => {
    const app = await build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/scrape/runs/12/threads',
      headers: AUTH,
      payload: {},
    });

    assert.equal(response.statusCode, 400);
    await app.close();
  });

  test('ingests a thread and returns the continue decision', async () => {
    let received: { runId: number; file: LihkgThreadFile } | null = null;
    const service = fakeApi({
      async ingestThread(runId, file) {
        received = { runId, file };
        return {
          action: 'stop',
          stopReason: 'limit',
          thread: {
            threadId: 5,
            externalThreadId: '900001',
            added: 2,
            seen: 2,
            skippedRestricted: 0,
            hidden: 0,
          },
          error: null,
          run: progress({ threadsProcessed: 1, commentsAdded: 2, status: 'success', stopReason: 'limit' }),
        };
      },
    });
    const app = await build({ service });

    const response = await app.inject({
      method: 'POST',
      url: '/api/scrape/runs/12/threads',
      headers: AUTH,
      payload: THREAD,
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.data.action, 'stop');
    assert.equal(body.data.stopReason, 'limit');
    assert.equal(body.data.run.commentsAdded, 2);
    assert.equal(received!.runId, 12);
    assert.equal(received!.file.response.thread_id, 900001);
    await app.close();
  });

  test('accepts an empty finish body', async () => {
    const app = await build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/scrape/runs/12/finish',
      headers: AUTH,
      payload: {},
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.run.stopReason, 'exhausted');
    await app.close();
  });

  test('turns a service HttpError into the standard error envelope', async () => {
    const service = fakeApi({
      async getRun() {
        throw new HttpError(404, 'SCRAPE_RUN_NOT_FOUND', 'scrape run 99 was not found');
      },
    });
    const app = await build({ service });

    const response = await app.inject({
      method: 'GET',
      url: '/api/scrape/runs/99',
      headers: AUTH,
    });

    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), {
      code: 404,
      message: 'scrape run 99 was not found',
      data: null,
    });
    await app.close();
  });

  test('reports no active run as null', async () => {
    const app = await build();
    const response = await app.inject({
      method: 'GET',
      url: '/api/scrape/runs/active',
      headers: AUTH,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.run, null);
    await app.close();
  });
});
