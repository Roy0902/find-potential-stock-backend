import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { AppConfig } from './config.js';
import type { CommentRepository } from './repository/commentRepository.js';
import type { Database } from './db.js';
import { commentRoutes } from './comments/routes.js';
import { forumRoutes } from './forums/routes.js';
import { healthRoutes } from './health/routes.js';
import { HttpError, sendError, toErrorEnvelope } from './http-error.js';
import { ThreadRepository } from './repository/threadRepository.js';
import { threadRoutes } from './threads/routes.js';
import { AdminRepository } from './repository/adminRepository.js';
import { adminRoutes } from './admin/routes.js';
import { SessionStore } from './auth/session.js';
import { LoginRateLimiter } from './auth/rate-limit.js';
import { makeGuard } from './auth/guard.js';
import { authRoutes } from './auth/routes.js';
import { legalRoutes } from './legal/routes.js';

export type BuildAppOptions = {
  config: AppConfig;
  db: Database;
  repository: CommentRepository;
  logger?: boolean;
};

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config, db, repository } = options;

  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: config.logLevel,
          },
    ajv: { customOptions: { coerceTypes: true } },
  });

  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send(toErrorEnvelope(error));
    }

    if (error.validation) {
      return reply.status(400).send(
        toErrorEnvelope(new HttpError(400, 'VALIDATION_FAILED', error.message)),
      );
    }

    request.log.error({ err: error }, 'unhandled request error');
    return reply
      .status(500)
      .send(toErrorEnvelope(new HttpError(500, 'INTERNAL_ERROR', 'Internal server error')));
  });

  app.setNotFoundHandler((request, reply) =>
    reply
      .status(404)
      .send(toErrorEnvelope(new HttpError(404, 'NOT_FOUND', `Route ${request.url} not found`))),
  );

  const sessions = new SessionStore(db, config.sessionTtlMinutes);
  const limiter = new LoginRateLimiter(config.loginRateLimit, config.loginRateWindowMinutes);

  // Drop expired sessions even when nobody tries to use them.
  const cleanupTimer = setInterval(() => {
    void sessions.destroyExpired();
  }, 10 * 60_000);
  cleanupTimer.unref();
  app.addHook('onClose', async () => clearInterval(cleanupTimer));

  await app.register(healthRoutes, { db });
  await app.register(commentRoutes, { repository });
  await app.register(forumRoutes, { repository });
  await app.register(threadRoutes, { repository: new ThreadRepository(db) });
  await app.register(authRoutes, { db, sessions, limiter, config });
  await app.register(legalRoutes);

  await app.register(async (admin) => {
    // Same-origin check on mutations (AMB-shared-010). Browsers send Origin for
    // cross-origin writes; a mismatched value is rejected before authentication.
    admin.addHook('preHandler', async (request, reply) => {
      if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') {
        return;
      }
      const origin = request.headers.origin;
      if (origin && !config.corsOrigins.includes(origin)) {
        await sendError(reply, new HttpError(403, 'FORBIDDEN_ORIGIN', 'Origin not allowed.'));
        return reply;
      }
    });
    admin.addHook('preHandler', makeGuard(sessions));
    await admin.register(adminRoutes, { repository: new AdminRepository(db) });
  });

  return app;
}
