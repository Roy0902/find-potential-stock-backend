import type { Database } from '../db.js';
import type { ListCommentsQuery } from '../types/request/comments.request.js';
import type { CommentRow } from '../types/data/comment.data.js';
import type { CommentListResponse, CommentSummary } from '../types/response/comments.response.js';
import type { ForumListResponse } from '../types/response/forums.response.js';

/**
 * Read side of the public site. Implementations must always exclude hidden
 * comments and blocked authors (FR-26). The order is newest first (FR-19).
 */
export interface CommentRepository {
  listComments(query: ListCommentsQuery): Promise<CommentListResponse>;
  listForums(): Promise<ForumListResponse>;
  getCommentById(id: number): Promise<CommentSummary | null>;
  /** Returns the stored source URL even when the comment is hidden or blocked. */
  findSourceUrlById(id: number): Promise<string | null>;
}

const EXCERPT_LENGTH = 200;

export function buildExcerpt(body: string): string {
  return [...body].slice(0, EXCERPT_LENGTH).join('');
}

function toSummary(row: CommentRow): CommentSummary {
  return {
    id: row.id,
    body: row.body,
    postedAt: row.posted_at.toISOString(),
    url: row.url,
    threadId: row.thread_id,
    threadTitle: row.thread_title,
    sourceName: row.source_name,
    author: {
      displayName: row.display_name,
      externalId: row.external_id,
      isBlocked: row.is_blocked,
    },
    parentId: row.parent_id,
    replyTargetUnknown: row.reply_target_unknown,
    excerpt: buildExcerpt(row.body),
  };
}

const COMMENT_SELECT = `
  SELECT c.id,
         c.body,
         c.posted_at,
         c.url,
         c.thread_id,
         t.title AS thread_title,
         s.name AS source_name,
         a.external_id,
         a.display_name,
         a.is_blocked,
         c.parent_id,
         c.reply_target_unknown
    FROM comment c
    JOIN thread t ON t.id = c.thread_id
    JOIN source s ON s.id = c.source_id
    JOIN author a ON a.id = c.author_id`;

const VISIBLE_ONLY = 'c.is_hidden = false AND a.is_blocked = false';

export class PostgresCommentRepository implements CommentRepository {
  constructor(private readonly db: Database) {}

  private whereClause(query: ListCommentsQuery): { sql: string; values: unknown[] } {
    const conditions = [VISIBLE_ONLY];
    const values: unknown[] = [];

    if (query.forumId !== undefined) {
      values.push(query.forumId);
      conditions.push(`c.source_id = $${values.length}`);
    }

    if (query.search) {
      values.push(query.search);
      const term = `$${values.length}`;
      conditions.push(`(
        c.body ILIKE '%' || ${term} || '%'
        OR EXISTS (
          SELECT 1
            FROM comment_stock cs
            JOIN stock st ON st.id = cs.stock_id
            LEFT JOIN stock_alias sa ON sa.stock_id = st.id
           WHERE cs.comment_id = c.id
             AND (st.ticker ILIKE ${term} OR sa.alias ILIKE '%' || ${term} || '%')
        )
      )`);
    }

    return { sql: conditions.join(' AND '), values };
  }

  async listComments(query: ListCommentsQuery): Promise<CommentListResponse> {
    // An unknown forum id means "no filter" (AMB-archive-search-008).
    let forumId = query.forumId;
    if (forumId !== undefined) {
      const exists = await this.db.query<{ id: number }>('SELECT id FROM source WHERE id = $1', [
        forumId,
      ]);
      if (!exists.rows.length) forumId = undefined;
    }
    const effective: ListCommentsQuery = { ...query, forumId };
    const where = this.whereClause(effective);
    const offset = (query.page - 1) * query.pageSize;

    const countResult = await this.db.query<{ total: number }>(
      `SELECT count(*)::int AS total
         FROM comment c
         JOIN author a ON a.id = c.author_id
        WHERE ${where.sql}`,
      where.values,
    );
    const total = countResult.rows[0]?.total ?? 0;

    const listValues = [...where.values, query.pageSize, offset];
    const listResult = await this.db.query<CommentRow>(
      `${COMMENT_SELECT}
        WHERE ${where.sql}
        ORDER BY c.posted_at DESC, c.id DESC
        LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`,
      listValues,
    );

    return {
      comments: listResult.rows.map(toSummary),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  }

  async listForums(): Promise<ForumListResponse> {
    const result = await this.db.query<{ id: number; name: string; comment_count: number }>(
      `SELECT s.id, s.name, count(c.id)::int AS comment_count
         FROM source s
         JOIN comment c ON c.source_id = s.id
         JOIN author a ON a.id = c.author_id
        WHERE ${VISIBLE_ONLY}
        GROUP BY s.id, s.name
        HAVING count(c.id) > 0
        ORDER BY s.name ASC`,
    );

    return {
      forums: result.rows.map((row: { id: number; name: string; comment_count: number }) => ({
        id: row.id,
        name: row.name,
        commentCount: row.comment_count,
      })),
    };
  }

  async getCommentById(id: number): Promise<CommentSummary | null> {
    const result = await this.db.query<CommentRow>(
      `${COMMENT_SELECT}
        WHERE c.id = $1 AND ${VISIBLE_ONLY}`,
      [id],
    );
    const row = result.rows[0];
    return row ? toSummary(row) : null;
  }

  async findSourceUrlById(id: number): Promise<string | null> {
    const result = await this.db.query<{ url: string }>(
      'SELECT url FROM comment WHERE id = $1',
      [id],
    );
    return result.rows[0]?.url ?? null;
  }
}
