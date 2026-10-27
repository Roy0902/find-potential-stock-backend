import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '../config.js';
import type { IngestRepository } from '../repository/ingest.repository.js';
import type { ScrapeRepository } from '../repository/scrape.repository.js';
import type {
  LihkgThreadFile,
  ScrapeRunMode,
  ScrapeRunStatus,
} from '../types/data/scrape.data.js';
import { parseEventLine } from './events.js';
import { LogWriter } from './log-writer.js';
import { ErrorNotifier, type ErrorReport } from './notifier.js';

export type RunStore = Pick<
  ScrapeRepository,
  'findSource' | 'createRun' | 'finishRun' | 'findRunning' | 'markStaleFailed' | 'setLogFile'
>;

export type ThreadIngestor = Pick<IngestRepository, 'ingestThread' | 'hideThread'>;

export type ScrapeRunOptions = {
  mode?: ScrapeRunMode;
  keyword?: string;
  limit?: number;
  dryRun?: boolean;
  headed?: boolean;
};

export type ScrapeRunResult = {
  skipped: boolean;
  reason?: string;
  runId: number | null;
  status: Exclude<ScrapeRunStatus, 'running'> | null;
  commentsAdded: number;
  commentsSkippedRestricted: number;
  errors: number;
  logFile: string | null;
  stopReason: string;
};

export type ScrapeRunnerOptions = {
  config: AppConfig;
  runs: RunStore;
  ingest: ThreadIngestor;
  notifier?: ErrorNotifier;
  scriptPath?: string;
  cwd?: string;
  spawnFn?: typeof spawn;
  logWriterFactory?: (options: { dir: string; maxBytes: number }) => LogWriter;
  now?: () => Date;
};

const DEFAULT_SCRIPT = fileURLToPath(
  new URL('../../scripts/scrape/lihkg-keyword-pipeline.mjs', import.meta.url),
);

function backendRoot(): string {
  return fileURLToPath(new URL('../..', import.meta.url));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  );
}

/** Kill the scraper and its Chromium children, not just the Node process. */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).unref();
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function findThreadFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findThreadFiles(full)));
    } else if (/^thread-\d+(?:-.+)?-comments\.json$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files.sort();
}

function pipeLines(
  stream: NodeJS.ReadableStream | null,
  onLine: (line: string) => void,
): void {
  if (!stream) return;
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) onLine(line);
  });
  stream.on('end', () => {
    if (buffer.trim()) onLine(buffer);
  });
}

export class ScrapeRunner {
  private readonly config: AppConfig;
  private readonly runs: RunStore;
  private readonly ingest: ThreadIngestor;
  private readonly notifier: ErrorNotifier | undefined;
  private readonly scriptPath: string;
  private readonly cwd: string;
  private readonly spawnFn: typeof spawn;
  private readonly logWriterFactory: (options: { dir: string; maxBytes: number }) => LogWriter;
  private readonly now: () => Date;

  private child: ChildProcess | null = null;
  private running = false;
  private aborted = false;
  private idle: Promise<void> | null = null;
  private markIdle: (() => void) | null = null;

  constructor(options: ScrapeRunnerOptions) {
    this.config = options.config;
    this.runs = options.runs;
    this.ingest = options.ingest;
    this.notifier = options.notifier;
    this.scriptPath = options.scriptPath ?? DEFAULT_SCRIPT;
    this.cwd = options.cwd ?? backendRoot();
    this.spawnFn = options.spawnFn ?? spawn;
    this.logWriterFactory =
      options.logWriterFactory ??
      ((logOptions) => new LogWriter(logOptions));
    this.now = options.now ?? (() => new Date());
  }

  get isRunning(): boolean {
    return this.running;
  }

  async run(options: ScrapeRunOptions = {}): Promise<ScrapeRunResult> {
    if (this.running) {
      return this.skipped('another scrape run is already active');
    }

    this.running = true;
    this.aborted = false;
    this.idle = new Promise((resolve) => {
      this.markIdle = resolve;
    });

    const mode = options.mode ?? 'incremental';
    const keyword = options.keyword ?? this.config.scrape.keywords[0] ?? '劇';
    const limit = options.limit ?? this.config.scrape.limit;
    const dryRun = options.dryRun ?? false;
    const startedAt = this.now();

    const logDir = dryRun
      ? resolve(this.cwd, this.config.scrape.logDir, 'dry')
      : resolve(this.cwd, this.config.scrape.logDir);
    const writer = this.logWriterFactory({
      dir: logDir,
      maxBytes: this.config.scrape.logMaxBytes,
    });
    await writer.init();

    let runId: number | null = null;
    let sourceId: number | null = null;
    let status: Exclude<ScrapeRunStatus, 'running'> = 'failed';
    let stopReason = 'completed';
    let commentsAdded = 0;
    let commentsSkippedRestricted = 0;
    let incomplete = false;
    let exitCode: number | null = null;
    let timedOut = false;
    let errorMessages: string[] = [];

    try {
      if (keyword.startsWith('-')) {
        throw new Error('scrape keyword must not start with "-"');
      }
      if (dryRun) {
        await writer.write(
          'info',
          `scrape run started (dry-run, mode=${mode}, keyword=${keyword}, limit=${limit})`,
        );
      } else {
        const source = await this.runs.findSource(this.config.scrape.source);
        if (!source) {
          throw new Error(
            `source "${this.config.scrape.source}" is missing or disabled in the database`,
          );
        }
        sourceId = source.id;

        const stale = await this.runs.markStaleFailed(this.config.scrape.staleMinutes);
        if (stale > 0) {
          await writer.write('warning', `marked ${stale} stale running run(s) as failed`);
        }
        const running = await this.runs.findRunning();
        if (running) {
          console.warn(`scrape skipped: run ${running.id} is still running`);
          await writer.close();
          return this.skipped('another scrape run is still running');
        }

        try {
          runId = await this.runs.createRun(source.id, mode, writer.path);
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          console.warn('scrape skipped: another process created a running scrape_run');
          await writer.close();
          return this.skipped('another scrape run is still running');
        }
        await writer.write(
          'info',
          `scrape run ${runId} started (mode=${mode}, keyword=${keyword}, limit=${limit})`,
        );
        await writer.write(
          'info',
          `scrape run ${runId} created (source=${source.name}, log=${writer.path})`,
        );
      }

      if (this.aborted) {
        throw new Error('shutdown requested before the scraper started');
      }

      const outputDir = resolve(
        this.cwd,
        this.config.scrape.outputDir,
        `run-${runId ?? `dry-${startedAt.getTime()}`}`,
      );
      // A reused run id (after a database reset) must not ingest files left by the old run.
      await rm(outputDir, { recursive: true, force: true });
      await mkdir(outputDir, { recursive: true });

      const result = await this.spawnScraper({
        writer,
        keyword,
        limit,
        outputDir,
        headed: options.headed ?? false,
      });
      exitCode = result.exitCode;
      timedOut = result.timedOut;
      errorMessages = result.errors;
      if (result.stopReason) stopReason = result.stopReason;
      if (this.aborted) stopReason = 'shutdown';
      if (timedOut) {
        stopReason = 'timeout';
        const message = `scraper timed out after ${this.config.scrape.timeoutMinutes} minute(s)`;
        errorMessages.push(message);
        await writer.write('error', message);
      }

      if (exitCode !== 0 && !timedOut && !this.aborted) {
        stopReason = 'error';
        const message = `scraper exited with code ${exitCode}`;
        errorMessages.push(message);
        await writer.write('error', message);
      }

      if (!dryRun && sourceId !== null) {
        const ingested = await this.ingestOutput(writer, outputDir, sourceId, startedAt);
        commentsAdded = ingested.added;
        commentsSkippedRestricted = ingested.skippedRestricted;
        incomplete = ingested.incomplete;
        errorMessages.push(...ingested.errors);
      }

      if (this.aborted) {
        status = 'failed';
      } else if (exitCode !== 0 || timedOut) {
        status = commentsAdded > 0 ? 'partial' : 'failed';
      } else if (writer.errorCount > 0 || errorMessages.length > 0) {
        status = commentsAdded > 0 ? 'partial' : 'failed';
      } else if (incomplete || stopReason === 'rate-limited') {
        status = 'partial';
      } else {
        status = 'success';
      }

      await writer.write(
        'info',
        `scrape run finished: status=${status}, stop_reason=${stopReason}, ` +
          `comments_added=${commentsAdded}, restricted=${commentsSkippedRestricted}, ` +
          `errors=${writer.errorCount}`,
      );
    } catch (error) {
      status = 'failed';
      stopReason = this.aborted ? 'shutdown' : 'error';
      const message = messageOf(error);
      errorMessages.push(message);
      await writer.write('error', message).catch(() => undefined);
    } finally {
      const finishedAt = this.now();
      if (runId !== null) {
        await this.runs
          .finishRun(runId, {
            status,
            commentsAdded,
            commentsUpdated: 0,
            commentsSkippedRestricted,
            logFile: writer.firstPath,
            errorCount: Math.max(writer.errorCount, errorMessages.length),
            stopReason,
          })
          .catch(async (error) => {
            const message = `could not close scrape run ${runId}: ${messageOf(error)}`;
            errorMessages.push(message);
            await writer.write('error', message).catch(() => undefined);
          });
      }

      if (!dryRun && (writer.errorCount > 0 || errorMessages.length > 0) && this.notifier) {
        const emailErrors = errorMessages.length
          ? errorMessages
          : ['An error was written to the log.'];
        const report: ErrorReport = {
          id: runId,
          mode,
          status,
          startedAt,
          finishedAt,
          stopReason,
          logFile: writer.firstPath,
          commentsAdded,
          commentsSkippedRestricted,
          errors: emailErrors,
        };
        const result = await this.notifier.send(report);
        await writer
          .write(
            result.sent ? 'info' : 'warning',
            result.sent
              ? `alert email sent to ${this.config.smtp.to}`
              : `alert email not sent: ${result.error ?? 'unknown error'}`,
          )
          .catch(() => undefined);
      }

      await writer.close().catch(() => undefined);
      this.child = null;
      this.running = false;
      this.markIdle?.();
      this.markIdle = null;
      this.idle = null;
    }

    return {
      skipped: false,
      runId,
      status,
      commentsAdded,
      commentsSkippedRestricted,
      errors: writer.errorCount,
      logFile: writer.firstPath,
      stopReason,
    };
  }

  /** Ask the running child to stop and wait for the run to close its database row. */
  async stop(): Promise<void> {
    this.aborted = true;
    const child = this.child;
    if (child && child.exitCode === null) {
      await new Promise<void>((resolveStop) => {
        const timer = setTimeout(() => {
          killTree(child, 'SIGKILL');
          resolveStop();
        }, 10_000);
        timer.unref();
        child.once('close', () => {
          clearTimeout(timer);
          resolveStop();
        });
        killTree(child, 'SIGTERM');
      });
    }

    // `run()` still has to ingest output and close the scrape_run row after the child exits.
    if (this.idle) {
      const timeout = new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, 60_000);
        timer.unref();
      });
      await Promise.race([this.idle, timeout]);
    }
  }

  private skipped(reason: string, logFile: string | null = null): ScrapeRunResult {
    return {
      skipped: true,
      reason,
      runId: null,
      status: null,
      commentsAdded: 0,
      commentsSkippedRestricted: 0,
      errors: 0,
      logFile,
      stopReason: 'skipped',
    };
  }

  private async spawnScraper(input: {
    writer: LogWriter;
    keyword: string;
    limit: number;
    outputDir: string;
    headed: boolean;
  }): Promise<{
    exitCode: number | null;
    timedOut: boolean;
    stopReason?: string;
    errors: string[];
  }> {
    const args = [
      this.scriptPath,
      input.keyword,
      '--limit',
      String(input.limit),
      '--sort',
      this.config.scrape.sort,
      '--delay',
      String(this.config.scrape.delayMs),
      '--out',
      input.outputDir,
      '--json-logs',
      '--no-stop-on-complete',
    ];
    if (this.config.scrape.includeOp) args.push('--include-op');
    if (input.headed) args.push('--headed');

    const child = this.spawnFn(process.execPath, args, {
      cwd: this.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    this.child = child;

    if (this.aborted) {
      killTree(child, 'SIGTERM');
      throw new Error('shutdown requested while the scraper was starting');
    }

    let pending: Promise<void> = Promise.resolve();
    let stopReason: string | undefined;
    const errors: string[] = [];

    const handleLine = (line: string, stream: 'stdout' | 'stderr') => {
      const event = parseEventLine(line, stream);
      if (!event) return;
      pending = pending.then(async () => {
        try {
          await input.writer.write(event.level, event.message);
        } catch (error) {
          errors.push(`log write failed: ${messageOf(error)}`);
        }
        if (event.level === 'error') errors.push(event.message);
        if (event.stopReason) stopReason = event.stopReason;
      });
    };

    pipeLines(child.stdout, (line) => handleLine(line, 'stdout'));
    pipeLines(child.stderr, (line) => handleLine(line, 'stderr'));

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      killTree(child, 'SIGTERM');
      setTimeout(() => killTree(child, 'SIGKILL'), 5_000).unref();
    }, this.config.scrape.timeoutMinutes * 60_000);
    timeout.unref();

    const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
      child.once('error', rejectExit);
      child.once('close', (code) => resolveExit(code));
    }).finally(() => clearTimeout(timeout));

    await pending.catch(() => undefined);
    return { exitCode, timedOut, stopReason, errors };
  }

  private async ingestOutput(
    writer: LogWriter,
    outputDir: string,
    sourceId: number,
    runStartedAt: Date,
  ): Promise<{
    added: number;
    skippedRestricted: number;
    seen: number;
    incomplete: boolean;
    errors: string[];
  }> {
    const paths = await findThreadFiles(outputDir);

    if (!paths.length) {
      const message = `no thread output files found in ${outputDir}`;
      await writer.write('error', message);
      return {
        added: 0,
        skippedRestricted: 0,
        seen: 0,
        incomplete: true,
        errors: [message],
      };
    }

    let added = 0;
    let skippedRestricted = 0;
    let seen = 0;
    let ingestedThreads = 0;
    let incomplete = false;
    const errors: string[] = [];

    for (const path of paths) {
      const name = basename(path);
      try {
        const file = JSON.parse(await readFile(path, 'utf8')) as LihkgThreadFile;
        const threadId = file.response?.thread_id ?? name;
        if (file.response?.status === 3) {
          const hidden = await this.ingest.hideThread(sourceId, String(threadId), runStartedAt);
          await writer.write(
            'warning',
            `thread ${threadId} is deleted; hid ${hidden} stored comment(s)`,
          );
          continue;
        }
        if ((file.response?.item_data?.length ?? 0) === 0) {
          await writer.write(
            'warning',
            `thread ${threadId} returned 0 comments; possible layout change or empty thread`,
          );
        }
        ingestedThreads += 1;
        if (file._scrape?.incomplete || file._scrape?.error) {
          incomplete = true;
          await writer.write(
            'warning',
            `thread ${threadId} is incomplete; ingesting the comments that were captured`,
          );
        }
        const result = await this.ingest.ingestThread(file, sourceId, runStartedAt);
        added += result.added;
        skippedRestricted += result.skippedRestricted;
        seen += result.seen;
        await writer.write(
          'info',
          `thread ${threadId}: ${result.seen} seen, ${result.added} added, ` +
            `${result.hidden} hidden, ${result.skippedRestricted} restricted`,
        );
      } catch (error) {
        const message = `ingest failed for ${name}: ${messageOf(error)}`;
        errors.push(message);
        await writer.write('error', message);
      }
    }

    if (seen === 0 && ingestedThreads > 0) {
      const message = 'all thread files contained 0 comments; possible layout change';
      errors.push(message);
      await writer.write('error', message);
    }

    return { added, skippedRestricted, seen, incomplete, errors };
  }
}
