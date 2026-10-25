import { schedule, validate, type ScheduledTask } from 'node-cron';
import type { AppConfig } from '../config.js';
import type { ScrapeRunMode } from '../types/data/scrape.data.js';
import type { ScrapeRunOptions, ScrapeRunResult, ScrapeRunner } from './runner.js';

export type SchedulerLog = {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

export class ScrapeScheduler {
  private task: ScheduledTask | null = null;

  constructor(
    private readonly runner: ScrapeRunner,
    private readonly config: AppConfig,
    private readonly log: SchedulerLog,
  ) {}

  start(): void {
    if (!this.config.scrape.enabled) {
      this.log.info('scraper schedule is disabled (SCRAPE_ENABLED=false)');
      return;
    }
    if (!validate(this.config.scrape.cron)) {
      this.log.error(
        `SCRAPE_CRON is not a valid cron expression: "${this.config.scrape.cron}"; scraper disabled`,
      );
      return;
    }
    try {
      new Intl.DateTimeFormat('en', { timeZone: this.config.scrape.timezone });
    } catch {
      this.log.error(
        `SCRAPE_TIMEZONE is not a valid IANA time zone: "${this.config.scrape.timezone}"; scraper disabled`,
      );
      return;
    }

    this.task = schedule(
      this.config.scrape.cron,
      () =>
        this.runNow('incremental').catch((error) => {
          this.log.error(`scrape run failed: ${error instanceof Error ? error.message : error}`);
        }),
      {
        timezone: this.config.scrape.timezone,
        name: 'find-potential-stock-scrape',
        noOverlap: true,
      },
    );
    this.log.info(
      `scraper scheduled: "${this.config.scrape.cron}" (${this.config.scrape.timezone})`,
    );

    if (this.config.scrape.runOnStart) {
      this.log.info('SCRAPE_RUN_ON_START=true; starting one run now');
      void this.runNow('incremental').catch((error) => {
        this.log.error(`scrape run failed: ${error instanceof Error ? error.message : error}`);
      });
    }
  }

  async runNow(
    mode: ScrapeRunMode = 'incremental',
    options: ScrapeRunOptions = {},
  ): Promise<ScrapeRunResult> {
    try {
      const result = await this.runner.run({ ...options, mode });
      if (result.skipped) {
        this.log.warn(`scrape run skipped: ${result.reason ?? 'unknown reason'}`);
      } else {
        this.log.info(
          `scrape run ${result.runId ?? 'dry'} finished: ${result.status}, ` +
            `added=${result.commentsAdded}, errors=${result.errors}, log=${result.logFile ?? 'none'}`,
        );
      }
      return result;
    } catch (error) {
      this.log.error(`scrape run failed: ${error instanceof Error ? error.message : error}`);
      return {
        skipped: false,
        runId: null,
        status: 'failed',
        commentsAdded: 0,
        commentsSkippedRestricted: 0,
        errors: 1,
        logFile: null,
        stopReason: 'error',
      };
    }
  }

  async stop(): Promise<void> {
    if (this.task) {
      await this.task.destroy();
      this.task = null;
    }
    await this.runner.stop();
  }
}
