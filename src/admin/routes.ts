import type { FastifyInstance } from 'fastify';
import { HttpError } from '../http/http-error.js';
import { success } from '../http/http-response.js';
import type { AdminRepository } from '../repository/admin.repository.js';
import type {
  AdminCommentListQuery,
  AdminHiddenBody,
  AdminIdParams,
  AdminLimitQuery,
} from '../types/request/admin.request.js';

const idSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

export async function adminRoutes(
  app: FastifyInstance,
  options: { repository: AdminRepository },
) {
  const { repository } = options;

  app.get<{ Querystring: AdminCommentListQuery }>(
    '/api/admin/comments',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            q: { type: 'string', maxLength: 200 },
            author: { type: 'string', maxLength: 200 },
            source: { type: 'string', maxLength: 200 },
            page: { type: 'integer', minimum: 1, default: 1 },
            pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
    },
    async (request) =>
      success(
        await repository.listComments({
          q: request.query.q?.trim() || undefined,
          author: request.query.author?.trim() || undefined,
          source: request.query.source?.trim() || undefined,
          page: request.query.page ?? 1,
          pageSize: request.query.pageSize ?? 20,
        }),
      ),
  );

  app.patch<{ Params: AdminIdParams; Body: AdminHiddenBody }>(
    '/api/admin/comments/:id/hidden',
    {
      schema: {
        params: idSchema,
        body: {
          type: 'object',
          required: ['hidden'],
          additionalProperties: false,
          properties: { hidden: { type: 'boolean' } },
        },
      },
    },
    async (request) => {
      const hidden = request.body.hidden === true;
      const updated = await repository.setHidden(request.params.id, hidden);
      if (!updated) throw new HttpError(404, 'COMMENT_NOT_FOUND', 'Comment not found.');
      await repository.logAction(hidden ? 'hide_comment' : 'unhide_comment', 'comment', updated.id);
      return success({
        id: updated.id,
        isHidden: updated.is_hidden,
        hiddenReason: updated.hidden_reason,
      });
    },
  );

  app.delete<{ Params: AdminIdParams }>(
    '/api/admin/comments/:id',
    { schema: { params: idSchema } },
    async (request, reply) => {
      const deleted = await repository.deleteComment(request.params.id);
      if (!deleted) throw new HttpError(404, 'COMMENT_NOT_FOUND', 'Comment not found.');
      await repository.logAction('delete_comment', 'comment', deleted.id);
      return reply.status(204).send();
    },
  );

  app.get<{ Querystring: { blocked?: string } }>(
    '/api/admin/authors',
    { schema: { querystring: { type: 'object', properties: { blocked: { type: 'string' } } } } },
    async (request) =>
      success({ authors: await repository.listAuthors(request.query.blocked === 'true') }),
  );

  const setBlocked = (blocked: boolean) => async (request: { params: AdminIdParams }) => {
    const author = await repository.findAuthor(request.params.id);
    if (!author) throw new HttpError(404, 'AUTHOR_NOT_FOUND', 'Author not found.');
    if (author.is_blocked === blocked) {
      return success({ id: author.id, isBlocked: author.is_blocked, changed: false });
    }
    const updated = await repository.setBlocked(author.id, blocked);
    await repository.logAction(blocked ? 'block_author' : 'unblock_author', 'author', author.id);
    return success({ id: updated!.id, isBlocked: updated!.is_blocked, changed: true });
  };

  app.post<{ Params: AdminIdParams }>(
    '/api/admin/authors/:id/block',
    { schema: { params: idSchema } },
    setBlocked(true),
  );
  app.post<{ Params: AdminIdParams }>(
    '/api/admin/authors/:id/unblock',
    { schema: { params: idSchema } },
    setBlocked(false),
  );

  app.get<{ Querystring: AdminLimitQuery }>(
    '/api/admin/actions',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
        },
      },
    },
    async (request) =>
      success({ actions: await repository.listActions(request.query.limit ?? 50) }),
  );

  app.get<{ Querystring: AdminLimitQuery }>(
    '/api/admin/scrape-runs',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        },
      },
    },
    async (request) =>
      success({ runs: await repository.listScrapeRuns(request.query.limit ?? 20) }),
  );
}
