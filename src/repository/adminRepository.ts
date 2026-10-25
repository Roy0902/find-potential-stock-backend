import type { Database } from '../db.js';
import { buildExcerpt } from './commentRepository.js';
import type { AdminCommentRow } from '../types/data/admin.data.js';
import type { AdminAction, AdminComment, ScrapeRun } from '../types/response/admin.response.js';

const SELECT = `
  SELECT c.id, a.id AS author_id, c.body, c.posted_at, c.url, c.thread_id,
         t.title AS thread_title, s.name AS source_name,
         a.external_id, a.display_name, a.is_blocked,
         c.parent_id, c.reply_target_unknown, c.is_hidden, c.hidden_reason
    FROM comment c
    JOIN thread t ON t.id = c.thread_id
    JOIN source s ON s.id = c.source_id
    JOIN author a ON a.id = c.author_id`;

const toAdminComment = (row: AdminCommentRow): AdminComment => ({
  id: row.id,
  body: row.body,
  excerpt: buildExcerpt(row.body),
  postedAt: new Date(row.posted_at).toISOString(),
  url: row.url,
  threadId: row.thread_id,
  threadTitle: row.thread_title,
  sourceName: row.source_name,
  author: {
    id: row.author_id,
    displayName: row.display_name,
    externalId: row.external_id,
    isBlocked: row.is_blocked,
  },
  parentId: row.parent_id,
  replyTargetUnknown: row.reply_target_unknown,
  isHidden: row.is_hidden,
  hiddenReason: row.hidden_reason,
});

export class AdminRepository {
  constructor(private readonly db: Database) {}

  async listComments(query: {
    q?: string;
    author?: string;
    source?: string;
    page: number;
    pageSize: number;
  }) {
    const conditions: string[] = ['1 = 1'];
    const values: unknown[] = [];

    if (query.q) {
      values.push(query.q);
      conditions.push(`c.body ILIKE '%' || $${values.length} || '%'`);
    }
    if (query.author) {
      values.push(query.author);
      conditions.push(`a.display_name ILIKE '%' || $${values.length} || '%'`);
    }
    if (query.source) {
      values.push(query.source);
      conditions.push(`s.name ILIKE '%' || $${values.length} || '%'`);
    }
    const where = conditions.join(' AND ');

    const count = await this.db.query<{ total: number }>(
      `SELECT count(*)::int AS total
         FROM comment c
         JOIN thread t ON t.id = c.thread_id
         JOIN source s ON s.id = c.source_id
         JOIN author a ON a.id = c.author_id
        WHERE ${where}`,
      values,
    );
    const total = count.rows[0]?.total ?? 0;

    const listValues = [...values, query.pageSize, (query.page - 1) * query.pageSize];
    const rows = await this.db.query<AdminCommentRow>(
      `${SELECT} WHERE ${where}
        ORDER BY c.id ASC, c.id ASC
        LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`,
      listValues,
    );

    return {
      comments: rows.rows.map(toAdminComment),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  }

  async setHidden(id: number, hidden: boolean) {
    const result = await this.db.query<{ id: number; is_hidden: boolean; hidden_reason: string | null }>(
      `UPDATE comment
          SET is_hidden = $2,
              hidden_reason = CASE WHEN $2 THEN 'admin' ELSE NULL END
        WHERE id = $1
        RETURNING id, is_hidden, hidden_reason`,
      [id, hidden],
    );
    return result.rows[0] ?? null;
  }

  async deleteComment(id: number) {
    const result = await this.db.query<{ id: number }>(
      'DELETE FROM comment WHERE id = $1 RETURNING id',
      [id],
    );
    return result.rows[0] ?? null;
  }

  async listAuthors(blockedOnly: boolean) {
    const result = await this.db.query<{
      id: number;
      display_name: string;
      external_id: string;
      is_blocked: boolean;
    }>(
      `SELECT id, display_name, external_id, is_blocked
         FROM author
        ${blockedOnly ? 'WHERE is_blocked = true' : ''}
        ORDER BY display_name ASC`,
    );
    return result.rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      externalId: row.external_id,
      isBlocked: row.is_blocked,
    }));
  }

  async setBlocked(id: number, blocked: boolean) {
    const result = await this.db.query<{ id: number; is_blocked: boolean }>(
      `UPDATE author
          SET is_blocked = $2,
              blocked_at = CASE WHEN $2 THEN now() ELSE NULL END
        WHERE id = $1
        RETURNING id, is_blocked`,
      [id, blocked],
    );
    return result.rows[0] ?? null;
  }

  async findAuthor(id: number) {
    const result = await this.db.query<{ id: number; is_blocked: boolean }>(
      'SELECT id, is_blocked FROM author WHERE id = $1',
      [id],
    );
    return result.rows[0] ?? null;
  }

  async logAction(action: string, targetType: 'author' | 'comment', targetId: number) {
    await this.db.query(
      `INSERT INTO admin_action (action, target_type, target_id, created_at)
       VALUES ($1, $2, $3, now())`,
      [action, targetType, targetId],
    );
  }

  async listActions(limit: number): Promise<AdminAction[]> {
    const result = await this.db.query<{
      id: number;
      action: string;
      target_type: string;
      target_id: number;
      created_at: Date;
    }>(
      `SELECT id, action, target_type, target_id, created_at
         FROM admin_action
        ORDER BY created_at DESC, id DESC
        LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  async listScrapeRuns(limit: number): Promise<ScrapeRun[]> {
    const result = await this.db.query<{
      id: number;
      mode: string;
      status: string;
      started_at: Date;
      finished_at: Date | null;
      comments_added: number;
      comments_updated: number;
      comments_skipped_restricted: number;
      log_file: string | null;
      error_count: number;
      stop_reason: string | null;
    }>(
      `SELECT id, mode, status, started_at, finished_at,
              comments_added, comments_updated, comments_skipped_restricted,
              log_file, error_count, stop_reason
         FROM scrape_run
        ORDER BY started_at DESC, id DESC
        LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      mode: row.mode,
      status: row.status,
      startedAt: new Date(row.started_at).toISOString(),
      finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
      commentsAdded: row.comments_added,
      commentsUpdated: row.comments_updated,
      commentsSkippedRestricted: row.comments_skipped_restricted,
      logFile: row.log_file,
      errorCount: row.error_count,
      stopReason: row.stop_reason,
    }));
  }
}
