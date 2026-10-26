import type { FastifyInstance } from 'fastify';
import type { Database } from '../database/db.js';
import { success } from '../http/http-response.js';

export async function healthRoutes(app: FastifyInstance, options: { db: Database }) {
  app.get('/api/health', async (_request, reply) => {
    const databaseUp = await options.db.isAvailable();
    const statusCode = databaseUp ? 200 : 503;
    return reply.status(statusCode).send(
      success(
        { status: databaseUp ? 'ok' : 'degraded', database: databaseUp ? 'up' : 'down' },
        databaseUp ? 'OK' : 'Degraded',
        statusCode,
      ),
    );
  });
}
