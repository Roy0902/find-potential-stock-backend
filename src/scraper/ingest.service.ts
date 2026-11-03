import type { AppConfig } from '../config.js';
import { isUniqueViolation } from '../database/pg-error.js';
import { HttpError } from '../http/http-error.js';
import type { IngestRepository } from '../repository/ingest.repository.js';
import type { ScrapeRepository } from '../repository/scrape.repository.js';
import type {
  LihkgThreadFile,
  ScrapeIngestOutcome,
  ScrapeRunMode,
  ScrapeRunProgress,
  ScrapeRunRow,
  ScrapeRunStatus,
  ScrapeThreadReport,
} from '../types/data/scrape.data.js';

/** Mirrors COMPLETION in scripts/scrape/lihkg-keyword-pipeline.mjs. */
const COMPLETION = { archivedStatus: 4, minReplies: 1000 };

export type ScrapeRunStore = Pick<
  ScrapeRepository,
  | 'findSource'
  | 'markStaleFailed'
  | 'findRunning'
  | 'createRun'
  | 'getRun'
  | 'recordThread'
  | 'finishRun'
>;

export type ThreadIngestor = Pick<IngestRepository, 'ingestThread' | 'hideThread'>;

export type StartScrapeInput = {
  mode?: ScrapeRunMode;
  keyword?: string;
  limit?: number;
  stopOnComplete?: boolean;
};

export type FinishScrapeInput = {
  stopReason?: string;
  errors?: number;
};

export type FinishScrapeResult = {
  run: ScrapeRunProgress;
  alreadyFinished: boolean;
};

export type ScrapeIngestApi = {
  start(input?: StartScrapeInput): Promise<ScrapeRunProgress>;
  ingestThread(runId: number, file: LihkgThreadFile): Promise<ScrapeIngestOutcome>;
  finish(runId: number, input: FinishScrapeInput): Promise<FinishScrapeResult>;
  getRun(runId: number): Promise<ScrapeRunProgress>;
  getActive(): Promise<ScrapeRunProgress | null>;
};

function toProgress(row: ScrapeRunRow): ScrapeRunProgress {
  return {
    runId: row.id,
    status: row.status as ScrapeRunStatus,
    stopReason: row.stop_reason,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
    keyword: row.keyword,
    maxThreads: row.max_threads,
    stopOnComplete: row.stop_on_complete,
    threadsProcessed: row.threads_processed,
    commentsAdded: row.comments_added,
    commentsSkippedRestricted: row.comments_skipped_restricted,
    errorCount: row.error_count,
  };
}

/**
 * Matches the runner's status rules: any error downgrades the run, a rate limit or
 * incomplete capture is partial, everything else that stopped on purpose is success.
 */
function statusFor(
  stopReason: string,
  commentsAdded: number,
  errorCount: number,
): Exclude<ScrapeRunStatus, 'running'> {
  if (errorCount > 0 || stopReason === 'error') {
    return commentsAdded > 0 ? 'partial' : 'failed';
  }
  if (stopReason === 'rate-limited' || stopReason === 'incomplete') return 'partial';
  return 'success';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Server side of the HTTP scraping flow. The local Playwright script fetches LIHKG
 * (the server cannot: anonymous requests are rejected) and posts each raw thread
 * payload here. Ingestion, counters and the continue/stop decision stay on the
 * server, so the deployed database is the single source of truth.
 */
export class ScrapeIngestService implements ScrapeIngestApi {
  constructor(
    private readonly runs: ScrapeRunStore,
    private readonly ingest: ThreadIngestor,
    private readonly config: AppConfig,
  ) {}

  async start(input: StartScrapeInput = {}): Promise<ScrapeRunProgress> {
    const source = await this.runs.findSource(this.config.scrape.source);
    if (!source) {
      throw new HttpError(
        503,
        'SCRAPE_SOURCE_MISSING',
        `source "${this.config.scrape.source}" is missing or disabled in the database`,
      );
    }

    await this.runs.markStaleFailed(this.config.scrape.staleMinutes);
    const running = await this.runs.findRunning();
    if (running) {
      throw new HttpError(
        409,
        'SCRAPE_RUN_ACTIVE',
        `scrape run ${running.id} is still running; finish it or retry after it goes stale`,
      );
    }

    const keyword = input.keyword ?? this.config.scrape.keywords[0] ?? '劇';
    if (keyword.startsWith('-')) {
      throw new HttpError(400, 'INVALID_KEYWORD', 'scrape keyword must not start with "-"');
    }

    let runId: number;
    try {
      runId = await this.runs.createRun(source.id, input.mode ?? 'incremental', null, {
        keyword,
        maxThreads: input.limit ?? this.config.scrape.limit,
        stopOnComplete: input.stopOnComplete ?? false,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HttpError(409, 'SCRAPE_RUN_ACTIVE', 'another scrape run is still running');
      }
      throw error;
    }

    const run = await this.runs.getRun(runId);
    if (!run) throw new HttpError(500, 'SCRAPE_RUN_MISSING', 'created run could not be read back');
    return toProgress(run);
  }

  async ingestThread(runId: number, file: LihkgThreadFile): Promise<ScrapeIngestOutcome> {
    const run = await this.requireRunning(runId);
    const meta = file.response;
    if (!meta || !Number.isFinite(meta.thread_id)) {
      throw new HttpError(400, 'INVALID_THREAD', 'thread payload has no response.thread_id');
    }
    const externalThreadId = String(meta.thread_id);

    let thread: ScrapeThreadReport;
    let error: string | null = null;

    try {
      if (Number(meta.status) === 3) {
        // Same handling as the runner: a deleted thread hides what was already stored.
        const hidden = await this.ingest.hideThread(
          run.source_id,
          externalThreadId,
          run.started_at,
        );
        thread = {
          threadId: null,
          externalThreadId,
          added: 0,
          seen: 0,
          skippedRestricted: 0,
          hidden,
        };
      } else {
        const result = await this.ingest.ingestThread(file, run.source_id, run.started_at);
        thread = { ...result, externalThreadId };
      }
    } catch (caught) {
      // A single bad payload must not kill the whole run; match the runner, which
      // logs the failure and keeps ingesting the remaining threads.
      error = messageOf(caught);
      thread = {
        threadId: null,
        externalThreadId,
        added: 0,
        seen: 0,
        skippedRestricted: 0,
        hidden: 0,
      };
    }

    const updated = await this.runs.recordThread(runId, {
      added: thread.added,
      skippedRestricted: thread.skippedRestricted,
      errors: error ? 1 : 0,
    });
    if (!updated) {
      throw new HttpError(409, 'SCRAPE_RUN_NOT_RUNNING', `scrape run ${runId} is no longer running`);
    }

    const stopReason = this.decideStop(updated, file);
    if (!stopReason) {
      return {
        action: 'continue',
        stopReason: null,
        thread,
        error,
        run: toProgress(updated),
      };
    }

    const finished = await this.finalize(updated, stopReason);
    return {
      action: 'stop',
      stopReason,
      thread,
      error,
      run: toProgress(finished),
    };
  }

  async finish(runId: number, input: FinishScrapeInput): Promise<FinishScrapeResult> {
    const run = await this.getRunRow(runId);
    if (run.status !== 'running') {
      return { run: toProgress(run), alreadyFinished: true };
    }

    const stopReason = input.stopReason ?? 'client';
    const errorCount = run.error_count + (input.errors ?? 0);
    const status = statusFor(stopReason, run.comments_added, errorCount);

    await this.runs.finishRun(runId, {
      status,
      commentsAdded: run.comments_added,
      commentsUpdated: run.comments_updated,
      commentsSkippedRestricted: run.comments_skipped_restricted,
      logFile: run.log_file,
      errorCount,
      stopReason,
    });

    const finished = await this.runs.getRun(runId);
    return { run: toProgress(finished ?? run), alreadyFinished: false };
  }

  async getRun(runId: number): Promise<ScrapeRunProgress> {
    return toProgress(await this.getRunRow(runId));
  }

  async getActive(): Promise<ScrapeRunProgress | null> {
    const running = await this.runs.findRunning();
    if (!running) return null;
    const run = await this.runs.getRun(running.id);
    return run ? toProgress(run) : null;
  }

  private async getRunRow(runId: number): Promise<ScrapeRunRow> {
    const run = await this.runs.getRun(runId);
    if (!run) {
      throw new HttpError(404, 'SCRAPE_RUN_NOT_FOUND', `scrape run ${runId} was not found`);
    }
    return run;
  }

  private async requireRunning(runId: number): Promise<ScrapeRunRow> {
    const run = await this.getRunRow(runId);
    if (run.status !== 'running') {
      throw new HttpError(
        409,
        'SCRAPE_RUN_NOT_RUNNING',
        `scrape run ${runId} is ${run.status}` +
          (run.stop_reason ? ` (${run.stop_reason})` : ''),
      );
    }
    return run;
  }

  private decideStop(run: ScrapeRunRow, file: LihkgThreadFile): string | null {
    const meta = file.response;
    const completed =
      Number(meta.status) === COMPLETION.archivedStatus &&
      Number(meta.no_of_reply) >= COMPLETION.minReplies;

    if (run.stop_on_complete && completed) return 'completed';
    if (run.max_threads !== null && run.threads_processed >= run.max_threads) return 'limit';
    return null;
  }

  /** Closes a run that reached a stopping condition, with the counters already stored. */
  private async finalize(run: ScrapeRunRow, stopReason: string): Promise<ScrapeRunRow> {
    await this.runs.finishRun(run.id, {
      status: statusFor(stopReason, run.comments_added, run.error_count),
      commentsAdded: run.comments_added,
      commentsUpdated: run.comments_updated,
      commentsSkippedRestricted: run.comments_skipped_restricted,
      logFile: run.log_file,
      errorCount: run.error_count,
      stopReason,
    });
    return (await this.runs.getRun(run.id)) ?? run;
  }
}
