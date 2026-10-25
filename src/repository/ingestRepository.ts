import type { Database, Queryable } from '../db.js';
import type {
  IngestThreadResult,
  LihkgThreadFile,
  LihkgThreadItem,
} from '../types/data/scrape.data.js';
import { decodeHtml, detectLang } from '../scraper/html.js';

type PreparedComment = {
  postId: string;
  parentExternalId: string | null;
  authorExternalId: string;
  displayName: string;
  body: string;
  lang: string;
  postedAt: Date;
  url: string;
};

async function insertMany<Row>(
  tx: Queryable,
  table: string,
  columns: string[],
  rows: unknown[][],
  conflictClause: string,
  returning: string,
): Promise<Row[]> {
  if (!rows.length) return [];
  const chunkSize = 500;
  const inserted: Row[] = [];
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const values: unknown[] = [];
    const tuples = chunk.map((row) => {
      const placeholders = row.map((value) => {
        values.push(value);
        return `$${values.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    const result = await tx.query<Row>(
      `INSERT INTO ${table} (${columns.join(', ')})
       VALUES ${tuples.join(', ')}
       ${conflictClause}
       ${returning}`,
      values,
    );
    inserted.push(...result.rows);
  }
  return inserted;
}

function prepareComment(
  item: LihkgThreadItem,
  threadId: number,
  seenAt: Date,
): PreparedComment | null {
  if (!item.post_id || !item.user?.user_id) return null;
  if (item.status !== undefined && item.status !== 1) return null;

  const body = decodeHtml(item.msg);
  const postedAt = Number.isFinite(item.reply_time)
    ? new Date(item.reply_time * 1000)
    : seenAt;
  const page = Number.isFinite(item.page) && item.page > 0 ? item.page : 1;

  return {
    postId: item.post_id,
    parentExternalId: item.quote_post_id ?? null,
    authorExternalId: String(item.user.user_id),
    displayName: item.user_nickname ?? item.user.nickname ?? 'Unknown',
    body,
    lang: detectLang(body),
    postedAt,
    url: `https://lihkg.com/thread/${threadId}/page/${page}#${item.post_id}`,
  };
}

export class IngestRepository {
  constructor(private readonly db: Database) {}

  /** A source-deleted thread must not leave its old comments visible on the archive. */
  async hideThread(
    sourceId: number,
    externalThreadId: string,
    runStartedAt: Date,
  ): Promise<number> {
    const result = await this.db.query(
      `UPDATE comment c
          SET is_hidden = true,
              hidden_reason = 'source_removed'
         FROM thread t
        WHERE c.thread_id = t.id
          AND c.source_id = $1
          AND t.source_id = $1
          AND t.external_id = $2
          AND c.is_hidden = false
          AND c.last_seen_at < $3`,
      [sourceId, externalThreadId, runStartedAt],
    );
    return result.rowCount ?? 0;
  }

  async ingestThread(
    file: LihkgThreadFile,
    sourceId: number,
    runStartedAt: Date,
  ): Promise<IngestThreadResult> {
    const meta = file.response;
    if (!meta || !Number.isFinite(meta.thread_id)) {
      throw new Error('thread file has no response.thread_id');
    }

    const threadId = Number(meta.thread_id);
    const items = Array.isArray(meta.item_data) ? meta.item_data : [];
    const seenAt = new Date();

    // Completeness needs positive evidence: a valid page count and every declared page
    // captured. A missing `_scrape` block is treated as incomplete so an older or
    // truncated file can never trigger the source_removed hide.
    const scrape = file._scrape;
    const expectedPages = Number(scrape?.pages_expected);
    const capturedPages = Array.isArray(scrape?.pages_captured)
      ? scrape.pages_captured.length
      : 0;
    const complete =
      scrape?.incomplete !== true &&
      !scrape?.error &&
      Number.isInteger(expectedPages) &&
      expectedPages >= 1 &&
      capturedPages === expectedPages;

    let skippedRestricted = 0;
    const prepared = new Map<string, PreparedComment>();
    const presentIds = new Set<string>();
    for (const item of items) {
      if (item?.post_id) presentIds.add(item.post_id);
      const comment = prepareComment(item, threadId, seenAt);
      if (!comment) {
        skippedRestricted += 1;
        continue;
      }
      if (!prepared.has(comment.postId)) prepared.set(comment.postId, comment);
    }

    return this.db.transaction(async (tx) => {
      const thread = await tx.query<{ id: number }>(
        `INSERT INTO thread (source_id, external_id, title, url, first_seen_at, board)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (source_id, external_id) DO UPDATE
           SET title = EXCLUDED.title,
               url = EXCLUDED.url,
               board = EXCLUDED.board
         RETURNING id`,
        [
          sourceId,
          String(threadId),
          meta.title || '(untitled)',
          `https://lihkg.com/thread/${threadId}`,
          seenAt,
          meta.category?.name ?? null,
        ],
      );
      const threadRowId = thread.rows[0]!.id;

      const authors = new Map<string, string>();
      for (const comment of prepared.values()) {
        if (!authors.has(comment.authorExternalId)) {
          authors.set(comment.authorExternalId, comment.displayName);
        }
      }

      const authorRows = await insertMany<{ id: number; external_id: string }>(
        tx,
        'author',
        ['source_id', 'external_id', 'display_name'],
        [...authors].map(([externalId, displayName]) => [sourceId, externalId, displayName]),
        `ON CONFLICT (source_id, external_id) DO UPDATE
           SET display_name = EXCLUDED.display_name`,
        'RETURNING id, external_id',
      );
      const authorIds = new Map(authorRows.map((row) => [row.external_id, row.id]));

      const comments = [...prepared.values()];
      const inserted = await insertMany<{ external_id: string }>(
        tx,
        'comment',
        [
          'source_id',
          'thread_id',
          'author_id',
          'external_id',
          'parent_external_id',
          'reply_target_unknown',
          'body',
          'posted_at',
          'url',
          'first_seen_at',
          'last_seen_at',
          'is_hidden',
          'lang',
        ],
        comments.map((comment) => {
          const authorId = authorIds.get(comment.authorExternalId);
          if (!authorId) {
            throw new Error(`author ${comment.authorExternalId} was not upserted`);
          }
          return [
            sourceId,
            threadRowId,
            authorId,
            comment.postId,
            comment.parentExternalId,
            false,
            comment.body,
            comment.postedAt,
            comment.url,
            seenAt,
            seenAt,
            false,
            comment.lang,
          ];
        }),
        'ON CONFLICT (source_id, external_id) DO NOTHING',
        'RETURNING external_id',
      );

      if (comments.length) {
        const seenIds = comments.map((comment) => comment.postId);
        await tx.query(
          `UPDATE comment
              SET last_seen_at = $3,
                  is_hidden = CASE
                    WHEN hidden_reason = 'source_removed' THEN false
                    ELSE is_hidden
                  END,
                  hidden_reason = CASE
                    WHEN hidden_reason = 'source_removed' THEN NULL
                    ELSE hidden_reason
                  END
            WHERE source_id = $1
              AND thread_id = $2
              AND external_id = ANY($4::text[])`,
          [sourceId, threadRowId, seenAt, seenIds],
        );

        await tx.query(
          `UPDATE comment c
              SET parent_id = p.id,
                  reply_target_unknown = false
             FROM comment p
            WHERE c.source_id = $1
              AND c.thread_id = $2
              AND c.parent_external_id IS NOT NULL
              AND p.source_id = c.source_id
              AND p.thread_id = c.thread_id
              AND p.external_id = c.parent_external_id
              AND (c.parent_id IS DISTINCT FROM p.id OR c.reply_target_unknown)`,
          [sourceId, threadRowId],
        );

        await tx.query(
          `UPDATE comment c
              SET reply_target_unknown = true
            WHERE c.source_id = $1
              AND c.thread_id = $2
              AND c.parent_external_id IS NOT NULL
              AND c.reply_target_unknown = false
              AND NOT EXISTS (
                SELECT 1
                  FROM comment p
                 WHERE p.source_id = c.source_id
                   AND p.thread_id = c.thread_id
                   AND p.external_id = c.parent_external_id
              )`,
          [sourceId, threadRowId],
        );
      }

      let hidden = 0;
      // A complete scrape that returned zero comments is more likely a layout change than a
      // thread whose every comment was deleted. Never mass-hide on an empty result.
      if (complete && comments.length > 0) {
        const present = [...presentIds];
        const result = await tx.query(
          `UPDATE comment
              SET is_hidden = true,
                  hidden_reason = 'source_removed'
            WHERE source_id = $1
              AND thread_id = $2
              AND is_hidden = false
              AND last_seen_at < $4
              AND NOT (external_id = ANY($3::text[]))`,
          [sourceId, threadRowId, present, runStartedAt],
        );
        hidden = result.rowCount ?? 0;
      }

      return {
        threadId: threadRowId,
        added: inserted.length,
        seen: comments.length,
        skippedRestricted,
        hidden,
      };
    });
  }
}
