import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config.js';
import { HttpError } from '../../src/http/http-error.js';
import type { FinishRunInput } from '../../src/repository/scrape.repository.js';
import {
  ScrapeIngestService,
  type ScrapeRunStore,
  type ThreadIngestor,
} from '../../src/scraper/ingest.service.js';
import type {
  LihkgThreadFile,
  LihkgThreadItem,
  ScrapeRunMode,
  ScrapeRunRow,
} from '../../src/types/data/scrape.data.js';

/** In-memory scrape_run table with the same state transitions as Postgres. */
class FakeRuns implements ScrapeRunStore {
  private readonly rows = new Map<number, ScrapeRunRow>();
  private nextId = 1;
  source: { id: number; name: string } | null = { id: 7, name: 'LIHKG' };
  staleClosed = 0;

  async findSource() {
    return this.source;
  }

  async markStaleFailed() {
    return this.staleClosed;
  }

  async findRunning() {
    const row = [...this.rows.values()].find((candidate) => candidate.status === 'running');
    return row ? { id: row.id, started_at: row.started_at } : null;
  }

  async createRun(
    sourceId: number,
    mode: ScrapeRunMode,
    logFile: string | null,
    options: { keyword?: string | null; maxThreads?: number | null; stopOnComplete?: boolean } = {},
  ) {
    const id = this.nextId++;
    this.rows.set(id, {
      id,
      source_id: sourceId,
      mode,
      started_at: new Date(),
      finished_at: null,
      status: 'running',
      comments_added: 0,
      comments_updated: 0,
      comments_skipped_restricted: 0,
      log_file: logFile,
      error_count: 0,
      stop_reason: null,
      keyword: options.keyword ?? null,
      max_threads: options.maxThreads ?? null,
      stop_on_complete: options.stopOnComplete ?? false,
      threads_processed: 0,
    });
    return id;
  }

  async getRun(id: number) {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async recordThread(
    id: number,
    delta: { added: number; skippedRestricted: number; errors: number },
  ) {
    const row = this.rows.get(id);
    if (!row || row.status !== 'running') return null;
    row.threads_processed += 1;
    row.comments_added += delta.added;
    row.comments_skipped_restricted += delta.skippedRestricted;
    row.error_count += delta.errors;
    return { ...row };
  }

  async finishRun(id: number, input: FinishRunInput) {
    const row = this.rows.get(id);
    if (!row) return;
    row.status = input.status;
    row.finished_at = new Date();
    row.comments_added = input.commentsAdded;
    row.comments_updated = input.commentsUpdated;
    row.comments_skipped_restricted = input.commentsSkippedRestricted;
    row.log_file = input.logFile;
    row.error_count = input.errorCount;
    row.stop_reason = input.stopReason;
  }
}

function threadFile(
  overrides: Partial<LihkgThreadFile['response']> = {},
  items: LihkgThreadItem[] = [],
): LihkgThreadFile {
  return {
    success: 1,
    response: {
      thread_id: 900001,
      title: 'Fixture thread',
      status: 1,
      no_of_reply: items.length,
      total_page: 1,
      item_data: items,
      ...overrides,
    },
    _scrape: { incomplete: false, error: null, pages_captured: [1], pages_expected: 1 },
  };
}

const ITEM: LihkgThreadItem = {
  post_id: 'p1',
  msg_num: 2,
  page: 1,
  msg: 'hello',
  reply_time: 1_790_000_000,
  status: 1,
  user: { user_id: 1, nickname: 'Alice' },
};

function ingestor(overrides: Partial<ThreadIngestor> = {}): ThreadIngestor {
  return {
    async ingestThread() {
      return { threadId: 42, added: 1, seen: 1, skippedRestricted: 0, hidden: 0 };
    },
    async hideThread() {
      return 0;
    },
    ...overrides,
  };
}

const config = loadConfig({ SCRAPE_INGEST_TOKEN: 'test-token', SCRAPE_LIMIT: '2' });

describe('ScrapeIngestService.start', () => {
  test('creates a run with the requested keyword and limit', async () => {
    const runs = new FakeRuns();
    const service = new ScrapeIngestService(runs, ingestor(), config);

    const run = await service.start({ keyword: '劇', limit: 3 });

    assert.equal(run.status, 'running');
    assert.equal(run.keyword, '劇');
    assert.equal(run.maxThreads, 3);
    assert.equal(run.stopOnComplete, false);
    assert.equal(run.threadsProcessed, 0);
    assert.equal((await service.getActive())?.runId, run.runId);
  });

  test('uses the configured limit and keyword when the body omits them', async () => {
    const service = new ScrapeIngestService(new FakeRuns(), ingestor(), config);

    const run = await service.start();

    assert.equal(run.maxThreads, 2);
    assert.equal(run.keyword, '劇');
  });

  test('refuses a second run while one is running', async () => {
    const service = new ScrapeIngestService(new FakeRuns(), ingestor(), config);
    await service.start();

    await assert.rejects(
      () => service.start(),
      (error: unknown) =>
        error instanceof HttpError &&
        error.statusCode === 409 &&
        error.code === 'SCRAPE_RUN_ACTIVE',
    );
  });

  test('rejects a missing source', async () => {
    const runs = new FakeRuns();
    runs.source = null;
    const service = new ScrapeIngestService(runs, ingestor(), config);

    await assert.rejects(
      () => service.start(),
      (error: unknown) =>
        error instanceof HttpError && error.code === 'SCRAPE_SOURCE_MISSING',
    );
  });
});

describe('ScrapeIngestService.ingestThread', () => {
  test('keeps going until the thread limit, then closes the run', async () => {
    const service = new ScrapeIngestService(new FakeRuns(), ingestor(), config);
    const run = await service.start({ limit: 2 });

    const first = await service.ingestThread(run.runId, threadFile({}, [ITEM]));
    assert.equal(first.action, 'continue');
    assert.equal(first.stopReason, null);
    assert.equal(first.thread.externalThreadId, '900001');
    assert.equal(first.run.threadsProcessed, 1);

    const second = await service.ingestThread(run.runId, threadFile());
    assert.equal(second.action, 'stop');
    assert.equal(second.stopReason, 'limit');
    assert.equal(second.run.status, 'success');
    assert.equal(second.run.threadsProcessed, 2);
    assert.equal(await service.getActive(), null);
  });

  test('stops on an archived full thread when stopOnComplete is set', async () => {
    const service = new ScrapeIngestService(new FakeRuns(), ingestor(), config);
    const run = await service.start({ limit: 10, stopOnComplete: true });

    const outcome = await service.ingestThread(
      run.runId,
      threadFile({ status: 4, no_of_reply: 1000 }),
    );

    assert.equal(outcome.action, 'stop');
    assert.equal(outcome.stopReason, 'completed');
    assert.equal(outcome.run.status, 'success');

    const ignored = await service.ingestThread(
      run.runId,
      threadFile({ status: 4, no_of_reply: 1000 }),
    ).catch((error: unknown) => error);
    assert.ok(ignored instanceof HttpError);
    assert.equal(ignored.code, 'SCRAPE_RUN_NOT_RUNNING');
  });

  test('does not stop on an archived thread when stopOnComplete is false', async () => {
    const service = new ScrapeIngestService(new FakeRuns(), ingestor(), config);
    const run = await service.start({ limit: 10, stopOnComplete: false });

    const outcome = await service.ingestThread(
      run.runId,
      threadFile({ status: 4, no_of_reply: 5000 }),
    );

    assert.equal(outcome.action, 'continue');
  });

  test('counts an ingest failure and tells the script to continue', async () => {
    const failing = ingestor({
      async ingestThread() {
        throw new Error('thread file has no response.thread_id');
      },
    });
    const service = new ScrapeIngestService(new FakeRuns(), failing, config);
    const run = await service.start({ limit: 5 });

    const outcome = await service.ingestThread(run.runId, threadFile());

    assert.equal(outcome.action, 'continue');
    assert.equal(outcome.error, 'thread file has no response.thread_id');
    assert.equal(outcome.run.errorCount, 1);
    assert.equal(outcome.thread.added, 0);

    const finished = await service.finish(run.runId, { stopReason: 'exhausted' });
    assert.equal(finished.run.status, 'failed');
  });

  test('hides comments for a deleted thread instead of ingesting it', async () => {
    let hidden = 0;
    const withHide = ingestor({
      async ingestThread() {
        throw new Error('ingestThread must not run for a deleted thread');
      },
      async hideThread(sourceId, externalThreadId) {
        assert.equal(sourceId, 7);
        assert.equal(externalThreadId, '900001');
        hidden = 3;
        return 3;
      },
    });
    const service = new ScrapeIngestService(new FakeRuns(), withHide, config);
    const run = await service.start({ limit: 1 });

    const outcome = await service.ingestThread(run.runId, threadFile({ status: 3 }));

    assert.equal(hidden, 3);
    assert.equal(outcome.thread.threadId, null);
    assert.equal(outcome.thread.hidden, 3);
    assert.equal(outcome.action, 'stop');
    assert.equal(outcome.stopReason, 'limit');
  });
});

describe('ScrapeIngestService.finish', () => {
  test('closes a rate-limited run as partial and is idempotent', async () => {
    const service = new ScrapeIngestService(new FakeRuns(), ingestor(), config);
    const run = await service.start({ limit: 10 });
    await service.ingestThread(run.runId, threadFile());

    const finished = await service.finish(run.runId, { stopReason: 'rate-limited' });
    assert.equal(finished.alreadyFinished, false);
    assert.equal(finished.run.status, 'partial');
    assert.equal(finished.run.stopReason, 'rate-limited');
    assert.ok(finished.run.finishedAt);

    const again = await service.finish(run.runId, { stopReason: 'rate-limited' });
    assert.equal(again.alreadyFinished, true);
  });

  test('fails a run with no ingested comments when the client reports errors', async () => {
    const service = new ScrapeIngestService(new FakeRuns(), ingestor(), config);
    const run = await service.start({ limit: 10 });

    const finished = await service.finish(run.runId, { stopReason: 'error', errors: 2 });

    assert.equal(finished.run.status, 'failed');
    assert.equal(finished.run.errorCount, 2);
  });

  test('returns 404 for an unknown run', async () => {
    const service = new ScrapeIngestService(new FakeRuns(), ingestor(), config);

    await assert.rejects(
      () => service.finish(999, {}),
      (error: unknown) => error instanceof HttpError && error.statusCode === 404,
    );
  });
});
