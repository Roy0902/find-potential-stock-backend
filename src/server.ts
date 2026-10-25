import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { PostgresCommentRepository } from './repository/commentRepository.js';
import { IngestRepository } from './repository/ingestRepository.js';
import { ScrapeRepository } from './repository/scrapeRepository.js';
import { createDatabase } from './db.js';
import { ErrorNotifier } from './scraper/notifier.js';
import { ScrapeRunner } from './scraper/runner.js';
import { ScrapeScheduler } from './scraper/scheduler.js';

async function main() {
  const config = loadConfig();
  const db = createDatabase(config);
  const repository = new PostgresCommentRepository(db);
  const app = await buildApp({ config, db, repository });

  if (!(await db.isAvailable())) {
    app.log.warn(
      'database is not reachable; /api/health will report degraded until it comes up',
    );
  }

  const runner = new ScrapeRunner({
    config,
    runs: new ScrapeRepository(db),
    ingest: new IngestRepository(db),
    notifier: new ErrorNotifier(config.smtp),
  });
  const scheduler = new ScrapeScheduler(runner, config, {
    info: (message) => app.log.info(message),
    warn: (message) => app.log.warn(message),
    error: (message) => app.log.error(message),
  });
  scheduler.start();

  const shutdown = async (signal: string) => {
    app.log.info(`received ${signal}, shutting down`);
    await scheduler.stop();
    await app.close();
    await db.end();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
