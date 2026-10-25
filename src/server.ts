import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { PostgresCommentRepository } from './repository/commentRepository.js';
import { createDatabase } from './db.js';

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

  const shutdown = async (signal: string) => {
    app.log.info(`received ${signal}, shutting down`);
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
