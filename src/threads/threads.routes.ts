import type { FastifyInstance } from 'fastify';
import type { ThreadRepository } from '../repository/thread.repository.js';
import type { ThreadRouteParams, ThreadRouteQuery } from '../types/request/threads.request.js';
import { HttpError, sendError } from '../http/http-error.js';
import { withLegacy } from '../http/http-response.js';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export async function threadRoutes(
  app: FastifyInstance,
  options: { repository: ThreadRepository },
) {
  app.get<{ Params: ThreadRouteParams; Querystring: ThreadRouteQuery }>(
    '/api/threads/:threadId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['threadId'],
          properties: { threadId: { type: 'integer', minimum: 1 } },
        },
        querystring: {
          type: 'object',
          properties: {
            commentId: { type: 'integer', minimum: 1 },
            page: { type: 'integer', minimum: 1, default: 1 },
            pageSize: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_PAGE_SIZE,
              default: DEFAULT_PAGE_SIZE,
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const page = await options.repository.getPage(request.params.threadId, {
          commentId: request.query.commentId,
          page: request.query.page ?? 1,
          pageSize: request.query.pageSize ?? DEFAULT_PAGE_SIZE,
        });
        if (!page) {
          throw HttpError.notFound('Thread not found.', 'THREAD_NOT_FOUND');
        }
        return withLegacy(page);
      } catch (error) {
        if (error instanceof HttpError) return sendError(reply, error);
        throw error;
      }
    },
  );
}
