import type { FastifyInstance } from 'fastify';
import type { CommentRepository } from '../repository/comment.repository.js';
import { withLegacy } from '../http/http-response.js';

export async function forumRoutes(
  app: FastifyInstance,
  options: { repository: CommentRepository },
) {
  app.get('/api/forums', async () => {
    const { forums } = await options.repository.listForums();
    return withLegacy({ forums });
  });
}
