#!/usr/bin/env node
import { loadConfig } from '../config.js';
import { createDatabase } from '../db.js';
import { IngestRepository } from '../repository/ingestRepository.js';
import { ScrapeRepository } from '../repository/scrapeRepository.js';
import type { ScrapeRunMode } from '../types/data/scrape.data.js';
import { ErrorNotifier } from './notifier.js';
import { ScrapeRunner } from './runner.js';

type CliOptions = {
  keyword?: string;
  limit?: number;
  mode: ScrapeRunMode;
  dryRun: boolean;
  headed: boolean;
};

function usage(): string {
  return [
    'Usage: npm run scrape -- [options]',
    '',
    '  --keyword <text>   Search keyword (default: SCRAPE_KEYWORDS)',
    '  --limit <n>        Threads to process (default: SCRAPE_LIMIT)',
    '  --mode <mode>      incremental | backfill (default: incremental)',
    '  --dry-run          Scrape and log without writing to the database',
    '  --headed           Show the browser window',
    '  --help             Show this help',
  ].join('\n');
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { mode: 'incremental', dryRun: false, headed: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--keyword':
        options.keyword = argv[++index];
        break;
      case '--limit': {
        const value = Number.parseInt(argv[++index] ?? '', 10);
        if (!Number.isFinite(value) || value < 1) {
          throw new Error('--limit must be a positive integer');
        }
        options.limit = value;
        break;
      }
      case '--mode': {
        const value = argv[++index];
        if (value !== 'incremental' && value !== 'backfill') {
          throw new Error('--mode must be "incremental" or "backfill"');
        }
        options.mode = value;
        break;
      }
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--headed':
        options.headed = true;
        break;
      case '--help':
        console.log(usage());
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const db = createDatabase(config);

  try {
    const runner = new ScrapeRunner({
      config,
      runs: new ScrapeRepository(db),
      ingest: new IngestRepository(db),
      notifier: new ErrorNotifier(config.smtp),
    });

    const result = await runner.run(options);
    if (result.skipped) {
      console.warn(`Scrape skipped: ${result.reason ?? 'unknown reason'}`);
    } else {
      console.log(
        `Scrape ${result.status}: added=${result.commentsAdded}, ` +
          `restricted=${result.commentsSkippedRestricted}, errors=${result.errors}, ` +
          `stop=${result.stopReason}, log=${result.logFile ?? 'none'}`,
      );
    }
    process.exitCode = result.status === 'failed' ? 1 : 0;
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
