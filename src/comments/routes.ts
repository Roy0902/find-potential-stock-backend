import type { FastifyInstance } from 'fastify';
import type { CommentsRouteQuery } from '../types/request/comments.request.js';
import type { CommentUnavailableResponse } from '../types/response/error.response.js';
import type { CommentRepository } from '../repository/commentRepository.js';
import { withLegacy } from '../http-response.js';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const listQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    page: { type: 'integer', minimum: 1, default: 1 },
    pageSize: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE },
    forumId: { type: 'integer', minimum: 1 },
    search: { type: 'string', maxLength: 200 },
  },
} as const;

export async function commentRoutes(
  app: FastifyInstance,
  options: { repository: CommentRepository },
) {
  const { repository } = options;

  app.get<{ Querystring: CommentsRouteQuery }>(
    '/api/comments',
    { schema: { querystring: listQuerySchema } },
    async (request) => {
      const page = request.query.page ?? 1;
      const pageSize = request.query.pageSize ?? DEFAULT_PAGE_SIZE;
      const search = request.query.search?.trim();

      const result = await repository.listComments({
        page,
        pageSize,
        forumId: request.query.forumId,
        search: search ? search : undefined,
      });
      return withLegacy(result);
    },
  );

  app.get<{ Params: { id: number } }>(
    '/api/comments/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'integer', minimum: 1 } },
        },
      },
    },
    async (request, reply) => {
      const comment = await repository.getCommentById(request.params.id);
      if (comment) return withLegacy(comment);

      const sourceUrl = await repository.findSourceUrlById(request.params.id);
      const unavailable: CommentUnavailableResponse = {
        code: 404,
        message: 'This comment is no longer available.',
        data: { sourceUrl: sourceUrl ?? null },
      };
      return reply.status(404).send(unavailable);
    },
  );
}
