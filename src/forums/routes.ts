import type { FastifyInstance } from 'fastify';
import type { CommentRepository } from '../repository/commentRepository.js';
import { withLegacy } from '../http-response.js';

export async function forumRoutes(
  app: FastifyInstance,
  options: { repository: CommentRepository },
) {
  app.get('/api/forums', async () => {
    const { forums } = await options.repository.listForums();
    return withLegacy({ forums });
  });
}
