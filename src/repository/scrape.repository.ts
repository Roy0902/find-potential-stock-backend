import type { Database } from '../database/db.js';
import type { ScrapeRunMode, ScrapeRunRow, ScrapeRunStatus } from '../types/data/scrape.data.js';

export type FinishRunInput = {
  status: Exclude<ScrapeRunStatus, 'running'>;
  commentsAdded: number;
  commentsUpdated: number;
  commentsSkippedRestricted: number;
  logFile: string | null;
  errorCount: number;
  stopReason: string;
};

export type CreateRunOptions = {
  keyword?: string | null;
  maxThreads?: number | null;
  stopOnComplete?: boolean;
};

export type ThreadRunDelta = {
  added: number;
  skippedRestricted: number;
  /** 1 when the thread payload failed to ingest, 0 otherwise. */
  errors: number;
};

const RUN_COLUMNS = `id, source_id, mode, started_at, finished_at, status,
        comments_added, comments_updated, comments_skipped_restricted,
        log_file, error_count, stop_reason, keyword, max_threads,
        stop_on_complete, threads_processed`;

export class ScrapeRepository {
  constructor(private readonly db: Database) {}

  async findSource(name: string): Promise<{ id: number; name: string } | null> {
    const result = await this.db.query<{ id: number; name: string }>(
      'SELECT id, name FROM source WHERE name = $1 AND enabled = true',
      [name],
    );
    return result.rows[0] ?? null;
  }

  async createRun(
    sourceId: number,
    mode: ScrapeRunMode,
    logFile: string | null,
    options: CreateRunOptions = {},
  ): Promise<number> {
    const result = await this.db.query<{ id: number }>(
      `INSERT INTO scrape_run
         (source_id, mode, started_at, status, log_file, keyword, max_threads, stop_on_complete)
       VALUES ($1, $2, now(), 'running', $3, $4, $5, $6)
       RETURNING id`,
      [
        sourceId,
        mode,
        logFile,
        options.keyword ?? null,
        options.maxThreads ?? null,
        options.stopOnComplete ?? false,
      ],
    );
    return result.rows[0]!.id;
  }

  async setLogFile(id: number, logFile: string): Promise<void> {
    await this.db.query('UPDATE scrape_run SET log_file = $2 WHERE id = $1', [id, logFile]);
  }

  async finishRun(id: number, input: FinishRunInput): Promise<void> {
    await this.db.query(
      `UPDATE scrape_run
          SET finished_at = now(),
              status = $2,
              comments_added = $3,
              comments_updated = $4,
              comments_skipped_restricted = $5,
              log_file = $6,
              error_count = $7,
              stop_reason = $8
        WHERE id = $1`,
      [
        id,
        input.status,
        input.commentsAdded,
        input.commentsUpdated,
        input.commentsSkippedRestricted,
        input.logFile,
        input.errorCount,
        input.stopReason,
      ],
    );
  }

  async findRunning(): Promise<{ id: number; started_at: Date } | null> {
    const result = await this.db.query<{ id: number; started_at: Date }>(
      `SELECT id, started_at
         FROM scrape_run
        WHERE status = 'running'
        ORDER BY started_at ASC
        LIMIT 1`,
    );
    return result.rows[0] ?? null;
  }

  /**
   * A crash or a killed process leaves a `running` row behind. Anything older than the
   * configured window is closed as failed before a new run may start.
   */
  async markStaleFailed(staleMinutes: number): Promise<number> {
    const result = await this.db.query<{ id: number }>(
      `UPDATE scrape_run
          SET status = 'failed',
              finished_at = now(),
              stop_reason = 'stale',
              error_count = error_count + 1
        WHERE status = 'running'
          AND started_at < now() - ($1::int * interval '1 minute')
        RETURNING id`,
      [staleMinutes],
    );
    return result.rows.length;
  }

  async getRun(id: number): Promise<ScrapeRunRow | null> {
    const result = await this.db.query<ScrapeRunRow>(
      `SELECT ${RUN_COLUMNS}
         FROM scrape_run
        WHERE id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Adds one ingested thread to the run's counters. Returns the refreshed row, or
   * null when the run is no longer `running` (another writer finished it first).
   */
  async recordThread(id: number, delta: ThreadRunDelta): Promise<ScrapeRunRow | null> {
    const result = await this.db.query<ScrapeRunRow>(
      `UPDATE scrape_run
          SET threads_processed = threads_processed + 1,
              comments_added = comments_added + $2,
              comments_skipped_restricted = comments_skipped_restricted + $3,
              error_count = error_count + $4
        WHERE id = $1
          AND status = 'running'
        RETURNING ${RUN_COLUMNS}`,
      [id, delta.added, delta.skippedRestricted, delta.errors],
    );
    return result.rows[0] ?? null;
  }
}
