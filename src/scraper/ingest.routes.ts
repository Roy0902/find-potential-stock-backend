import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { HttpError, sendError } from '../http/http-error.js';
import { success } from '../http/http-response.js';
import type { ScrapeRunMode, LihkgThreadFile } from '../types/data/scrape.data.js';
import type { ScrapeIngestApi } from './ingest.service.js';

export const SCRAPE_INGEST_TOKEN_HEADER = 'x-scrape-token';

/** Route bodies are a single raw thread file, so allow a full multi-page thread. */
const BODY_LIMIT = 16 * 1024 * 1024;

const runParamsSchema = {
  type: 'object',
  required: ['runId'],
  properties: { runId: { type: 'integer', minimum: 1 } },
} as const;

const startBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: { type: 'string', enum: ['backfill', 'incremental'] },
    keyword: { type: 'string', minLength: 1, maxLength: 200 },
    limit: { type: 'integer', minimum: 1, maximum: 1000 },
    stopOnComplete: { type: 'boolean' },
  },
} as const;

const finishBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    stopReason: { type: 'string', minLength: 1, maxLength: 100 },
    errors: { type: 'integer', minimum: 0, maximum: 100_000 },
  },
} as const;

/**
 * Permissive on purpose: a layout change in the LIHKG payload should surface as an
 * ingest warning, not a 400. The fields ingestion actually reads are required.
 */
const threadFileSchema = {
  type: 'object',
  required: ['success', 'response'],
  additionalProperties: true,
  properties: {
    success: { type: 'number' },
    response: {
      type: 'object',
      required: ['thread_id'],
      additionalProperties: true,
      properties: {
        thread_id: { type: 'integer' },
        title: { type: ['string', 'null'] },
        status: { type: ['integer', 'null'] },
        no_of_reply: { type: ['integer', 'null'], minimum: 0 },
        total_page: { type: ['integer', 'null'] },
        max_reply: { type: ['integer', 'null'] },
        create_time: { type: ['integer', 'null'] },
        user_nickname: { type: ['string', 'null'] },
        category: { type: ['object', 'null'], additionalProperties: true },
        user: { type: ['object', 'null'], additionalProperties: true },
        item_data: {
          type: ['array', 'null'],
          items: { type: 'object', additionalProperties: true },
        },
      },
    },
    _scrape: {
      type: 'object',
      additionalProperties: true,
      properties: {
        incomplete: { type: 'boolean' },
        error: { type: ['string', 'null'] },
        pages_expected: { type: 'integer' },
        pages_captured: { type: 'array', items: { type: 'integer' } },
      },
    },
  },
} as const;

type RunParams = { runId: number };
type StartBody = {
  mode?: ScrapeRunMode;
  keyword?: string;
  limit?: number;
  stopOnComplete?: boolean;
};
type FinishBody = { stopReason?: string; errors?: number };

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function makeTokenGuard(token: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!token) {
      await sendError(
        reply,
        new HttpError(
          503,
          'SCRAPE_INGEST_DISABLED',
          'SCRAPE_INGEST_TOKEN is not configured on this server.',
        ),
      );
      return reply;
    }

    const header = request.headers[SCRAPE_INGEST_TOKEN_HEADER];
    const provided = Array.isArray(header) ? header[0] : header;
    if (!provided || !tokenMatches(provided, token)) {
      await sendError(
        reply,
        new HttpError(401, 'UNAUTHENTICATED', 'A valid scraping ingest token is required.'),
      );
      return reply;
    }
  };
}

/**
 * HTTP ingest flow for the local scraping script:
 *
 *   POST /api/scrape/runs               start a run, get runId + limits
 *   POST /api/scrape/runs/:id/threads   post one raw thread file, get continue/stop
 *   POST /api/scrape/runs/:id/finish    close the run (exhausted, rate-limited, ...)
 *   GET  /api/scrape/runs/active        resume after a script restart
 *   GET  /api/scrape/runs/:id           inspect a run
 *
 * All routes require the SCRAPE_INGEST_TOKEN header.
 */
export async function scrapeIngestRoutes(
  app: FastifyInstance,
  options: { service: ScrapeIngestApi; token: string },
) {
  const { service, token } = options;

  // onRequest runs before body parsing, so an unauthenticated caller cannot make
  // the server buffer a 16 MiB thread payload.
  app.addHook('onRequest', makeTokenGuard(token));

  app.post<{ Body: StartBody }>(
    '/api/scrape/runs',
    { schema: { body: startBodySchema } },
    async (request) => success(await service.start(request.body ?? {})),
  );

  app.get('/api/scrape/runs/active', async () => success({ run: await service.getActive() }));

  app.get<{ Params: RunParams }>(
    '/api/scrape/runs/:runId',
    { schema: { params: runParamsSchema } },
    async (request) => success(await service.getRun(request.params.runId)),
  );

  app.post<{ Params: RunParams; Body: LihkgThreadFile }>(
    '/api/scrape/runs/:runId/threads',
    { bodyLimit: BODY_LIMIT, schema: { params: runParamsSchema, body: threadFileSchema } },
    async (request) => success(await service.ingestThread(request.params.runId, request.body)),
  );

  app.post<{ Params: RunParams; Body: FinishBody }>(
    '/api/scrape/runs/:runId/finish',
    { schema: { params: runParamsSchema, body: finishBodySchema } },
    async (request) => success(await service.finish(request.params.runId, request.body ?? {})),
  );
}
