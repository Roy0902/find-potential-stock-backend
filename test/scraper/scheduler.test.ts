import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config.js';
import { ScrapeScheduler } from '../../src/scraper/scheduler.js';
import { ScrapeRunner, type RunStore, type ThreadIngestor } from '../../src/scraper/runner.js';
import type { FinishRunInput } from '../../src/repository/scrape.repository.js';
import type { LihkgThreadFile } from '../../src/types/data/scrape.data.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/fake-scrape.mjs', import.meta.url));
const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fps-scheduler-'));
  dirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function configFor(dir: string, overrides: Record<string, string> = {}) {
  return loadConfig({
    SCRAPE_LOG_DIR: join(dir, 'logs'),
    SCRAPE_OUTPUT_DIR: join(dir, 'out'),
    SCRAPE_TIMEOUT_MINUTES: '1',
    SCRAPE_LIMIT: '1',
    SCRAPE_KEYWORDS: 'test',
    ...overrides,
  });
}

class FakeRuns implements RunStore {
  finished: FinishRunInput[] = [];

  async findSource() {
    return { id: 1, name: 'LIHKG' };
  }

  async createRun() {
    return 42;
  }

  async finishRun(_id: number, input: FinishRunInput) {
    this.finished.push(input);
  }

  async findRunning() {
    return null;
  }

  async markStaleFailed() {
    return 0;
  }

  async setLogFile() {
    // no-op
  }
}

class FakeIngest implements ThreadIngestor {
  async ingestThread(_file: LihkgThreadFile) {
    return { threadId: 1, added: 1, seen: 1, skippedRestricted: 0, hidden: 0 };
  }

  async hideThread() {
    return 0;
  }
}

function buildScheduler(
  dir: string,
  overrides: Record<string, string>,
): { scheduler: ScrapeScheduler; runs: FakeRuns; logs: string[] } {
  const runs = new FakeRuns();
  const config = configFor(dir, overrides);
  const runner = new ScrapeRunner({
    config,
    runs,
    ingest: new FakeIngest(),
    scriptPath: FIXTURE,
    cwd: process.cwd(),
  });
  const logs: string[] = [];
  const scheduler = new ScrapeScheduler(runner, config, {
    info: (message) => logs.push(`info: ${message}`),
    warn: (message) => logs.push(`warn: ${message}`),
    error: (message) => logs.push(`error: ${message}`),
  });
  return { scheduler, runs, logs };
}

describe('ScrapeScheduler', () => {
  test('does nothing when the schedule is disabled', async () => {
    const dir = await tempDir();
    const { scheduler, runs, logs } = buildScheduler(dir, { SCRAPE_ENABLED: 'false' });

    scheduler.start();
    await scheduler.stop();

    assert.ok(logs.some((line) => line.includes('disabled')));
    assert.equal(runs.finished.length, 0);
  });

  test('logs and disables itself for an invalid cron expression', async () => {
    const dir = await tempDir();
    const { scheduler, logs } = buildScheduler(dir, {
      SCRAPE_ENABLED: 'true',
      SCRAPE_CRON: 'not a cron',
    });

    scheduler.start();
    await scheduler.stop();

    assert.ok(logs.some((line) => line.includes('not a valid cron expression')));
  });

  test('logs and disables itself for an invalid time zone', async () => {
    const dir = await tempDir();
    const { scheduler, logs } = buildScheduler(dir, {
      SCRAPE_ENABLED: 'true',
      SCRAPE_TIMEZONE: 'Mars/Olympus',
    });

    scheduler.start();
    await scheduler.stop();

    assert.ok(logs.some((line) => line.includes('not a valid IANA time zone')));
  });

  test('runs every configured keyword sequentially', async () => {
    const dir = await tempDir();
    const { scheduler, runs, logs } = buildScheduler(dir, {
      SCRAPE_KEYWORDS: 'first,second',
    });

    const results = await scheduler.runAll('incremental');

    assert.equal(results.length, 2);
    assert.equal(runs.finished.length, 2);
    assert.ok(logs.some((line) => line.includes('scrape keyword "first"')));
    assert.ok(logs.some((line) => line.includes('scrape keyword "second"')));
    assert.ok(logs.some((line) => line.includes('scrape batch finished: 2/2 successful')));
  });

  test('schedules a fixed interval from server start instead of cron', async () => {
    const dir = await tempDir();
    const { scheduler, runs, logs } = buildScheduler(dir, {
      SCRAPE_ENABLED: 'true',
      SCRAPE_INTERVAL_HOURS: '24',
      SCRAPE_CRON: 'not a cron',
    });

    scheduler.start();
    await scheduler.stop();

    assert.ok(logs.some((line) => line.includes('every 24 hour(s) from server start')));
    assert.ok(!logs.some((line) => line.includes('not a valid cron expression')));
    assert.equal(runs.finished.length, 0);
  });

  test('runs once on startup when configured', async () => {
    const dir = await tempDir();
    const { scheduler, runs, logs } = buildScheduler(dir, {
      SCRAPE_ENABLED: 'true',
      SCRAPE_RUN_ON_START: 'true',
    });

    scheduler.start();
    const deadline = Date.now() + 15_000;
    while (runs.finished.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await scheduler.stop();

    assert.equal(runs.finished.length, 1);
    assert.ok(logs.some((line) => line.includes('scraper scheduled')));
    assert.ok(logs.some((line) => line.includes('scrape run 42 finished')));
  });
});
