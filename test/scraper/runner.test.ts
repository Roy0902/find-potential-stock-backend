import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config.js';
import { ErrorNotifier, type MailMessage } from '../../src/scraper/notifier.js';
import { ScrapeRunner, type RunStore, type ThreadIngestor } from '../../src/scraper/runner.js';
import type { FinishRunInput } from '../../src/repository/scrapeRepository.js';
import type { LihkgThreadFile } from '../../src/types/data/scrape.data.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/fake-scrape.mjs', import.meta.url));
const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fps-runner-'));
  dirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function configFor(dir: string) {
  return loadConfig({
    SCRAPE_LOG_DIR: join(dir, 'logs'),
    SCRAPE_OUTPUT_DIR: join(dir, 'out'),
    SCRAPE_TIMEOUT_MINUTES: '1',
    SCRAPE_LIMIT: '1',
    SCRAPE_KEYWORDS: 'test',
    SMTP_HOST: '',
  });
}

class FakeRuns implements RunStore {
  created: Array<{ sourceId: number; mode: string; logFile: string | null }> = [];
  finished: Array<{ id: number; input: FinishRunInput }> = [];
  running: { id: number; started_at: Date } | null = null;
  stale = 0;

  async findSource() {
    return { id: 1, name: 'LIHKG' };
  }

  async createRun(sourceId: number, mode: 'backfill' | 'incremental', logFile: string | null) {
    this.created.push({ sourceId, mode, logFile });
    return 42;
  }

  async finishRun(id: number, input: FinishRunInput) {
    this.finished.push({ id, input });
  }

  async findRunning() {
    return this.running;
  }

  async markStaleFailed() {
    return this.stale;
  }

  async setLogFile() {
    // no-op
  }
}

class FakeIngest implements ThreadIngestor {
  calls: Array<{ file: LihkgThreadFile; sourceId: number }> = [];

  async ingestThread(file: LihkgThreadFile, sourceId: number) {
    this.calls.push({ file, sourceId });
    return { threadId: 1, added: 1, seen: 1, skippedRestricted: 0, hidden: 0 };
  }

  async hideThread() {
    return 0;
  }
}

function notifier(sent: MailMessage[]): ErrorNotifier {
  return new ErrorNotifier(
    {
      host: 'smtp.test',
      port: 587,
      secure: false,
      user: 'user',
      pass: 'pass',
      from: 'alerts@test.local',
      to: 'roy2b32@gmail.com',
    },
    () => ({
      sendMail: async (message) => {
        sent.push(message);
      },
    }),
  );
}

async function runWithMode(mode: string, options: { dryRun?: boolean } = {}) {
  const dir = await tempDir();
  const runs = new FakeRuns();
  const ingest = new FakeIngest();
  const sent: MailMessage[] = [];
  process.env.FAKE_SCRAPE_MODE = mode;
  try {
    const runner = new ScrapeRunner({
      config: configFor(dir),
      runs,
      ingest,
      notifier: notifier(sent),
      scriptPath: FIXTURE,
      cwd: process.cwd(),
    });
    const result = await runner.run({ limit: 1, dryRun: options.dryRun });
    return { dir, runs, ingest, sent, result };
  } finally {
    delete process.env.FAKE_SCRAPE_MODE;
  }
}

describe('ScrapeRunner', () => {
  test('runs the scraper, ingests its output and closes the run', async () => {
    const { runs, ingest, sent, result } = await runWithMode('ok');

    assert.equal(result.skipped, false);
    assert.equal(result.runId, 42);
    assert.equal(result.status, 'success');
    assert.equal(result.commentsAdded, 1);
    assert.equal(result.errors, 0);
    assert.equal(runs.created.length, 1);
    assert.equal(runs.created[0]!.mode, 'incremental');
    assert.equal(runs.finished.length, 1);
    assert.equal(runs.finished[0]!.input.status, 'success');
    assert.equal(runs.finished[0]!.input.stopReason, 'completed');
    assert.equal(runs.finished[0]!.input.commentsAdded, 1);
    assert.equal(runs.finished[0]!.input.errorCount, 0);
    assert.equal(ingest.calls.length, 1);
    assert.equal(ingest.calls[0]!.sourceId, 1);
    assert.equal(ingest.calls[0]!.file.response.thread_id, 900001);
    assert.equal(sent.length, 0);

    const log = await readFile(result.logFile!, 'utf8');
    assert.match(log, /\[Info\].*scrape run 42 created/);
    assert.match(log, /\[Info\].*fake search page 1/);
    assert.match(log, /\[Warning\].*fake warning/);
    assert.match(log, /\[Info\].*scrape run finished: status=success/);
  });

  test('sends one alert email when the scraper logs an error', async () => {
    const { runs, sent, result } = await runWithMode('error');

    assert.equal(result.status, 'partial');
    assert.equal(result.commentsAdded, 1);
    assert.ok(result.errors >= 1);
    assert.equal(runs.finished[0]!.input.status, 'partial');
    assert.equal(runs.finished[0]!.input.stopReason, 'error');
    assert.equal(runs.finished[0]!.input.errorCount, result.errors);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.subject, /Scrape run 42 partial/);
    assert.match(sent[0]!.text, /fake failure/);
  });

  test('marks an incomplete thread as a partial run', async () => {
    const { runs, result } = await runWithMode('incomplete');

    assert.equal(result.status, 'partial');
    assert.equal(result.errors, 0);
    assert.equal(runs.finished[0]!.input.status, 'partial');
  });

  test('does not ingest a deleted thread', async () => {
    const { ingest, result } = await runWithMode('deleted');

    assert.equal(result.status, 'success');
    assert.equal(ingest.calls.length, 0);
  });

  test('skips when another run is still marked running', async () => {
    const dir = await tempDir();
    const runs = new FakeRuns();
    runs.running = { id: 99, started_at: new Date() };
    const ingest = new FakeIngest();
    const runner = new ScrapeRunner({
      config: configFor(dir),
      runs,
      ingest,
      scriptPath: FIXTURE,
      cwd: process.cwd(),
    });

    const result = await runner.run({ limit: 1 });

    assert.equal(result.skipped, true);
    assert.match(result.reason ?? '', /still running/);
    assert.equal(runs.created.length, 0);
    assert.equal(ingest.calls.length, 0);
    assert.match(await readFile(result.logFile!, 'utf8'), /skipping this run/);
  });

  test('reports stale runs before starting', async () => {
    const dir = await tempDir();
    const runs = new FakeRuns();
    runs.stale = 2;
    const runner = new ScrapeRunner({
      config: configFor(dir),
      runs,
      ingest: new FakeIngest(),
      scriptPath: FIXTURE,
      cwd: process.cwd(),
    });

    const result = await runner.run({ limit: 1 });

    assert.equal(result.status, 'success');
    assert.match(await readFile(result.logFile!, 'utf8'), /marked 2 stale running run/);
  });

  test('dry run does not create a run or ingest', async () => {
    const { runs, ingest, result } = await runWithMode('ok', { dryRun: true });

    assert.equal(result.runId, null);
    assert.equal(result.status, 'success');
    assert.equal(runs.created.length, 0);
    assert.equal(runs.finished.length, 0);
    assert.equal(ingest.calls.length, 0);
  });
});
