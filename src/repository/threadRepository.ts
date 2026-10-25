import type { Database } from '../db.js';
import { buildTree } from '../threads/tree.js';
import type { CommentNode, ThreadCommentRow } from '../types/data/comment.data.js';
import type { ThreadMeta } from '../types/data/thread.data.js';
import type { ThreadPage } from '../types/response/threads.response.js';

const COMMENT_SQL = `
  SELECT c.id,
         c.parent_id,
         c.parent_external_id,
         c.reply_target_unknown,
         c.body,
         c.posted_at,
         c.url,
         c.lang,
         a.display_name,
         a.external_id AS author_external_id,
         c.is_hidden,
         a.is_blocked
    FROM comment c
    JOIN author a ON a.id = c.author_id
   WHERE c.thread_id = $1
   ORDER BY c.posted_at ASC, c.id ASC`;

export class ThreadRepository {
  constructor(private readonly db: Database) {}

  async findThread(id: number): Promise<ThreadMeta | null> {
    const result = await this.db.query<{
      id: number;
      title: string;
      name: string;
      url: string;
    }>(
      `SELECT t.id, t.title, s.name, t.url
         FROM thread t
         JOIN source s ON s.id = t.source_id
        WHERE t.id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { id: row.id, title: row.title, sourceName: row.name, sourceUrl: row.url };
  }

  async getPage(
    id: number,
    options: { commentId?: number; page: number; pageSize: number },
  ): Promise<ThreadPage | null> {
    const thread = await this.findThread(id);
    if (!thread) return null;

    const result = await this.db.query<ThreadCommentRow>(COMMENT_SQL, [id]);
    const roots = buildTree(result.rows);

    const total = roots.length;
    const start = (options.page - 1) * options.pageSize;
    const comments = roots.slice(start, start + options.pageSize);

    return {
      thread,
      highlightedCommentId: options.commentId ?? null,
      comments,
      topLevel: {
        page: options.page,
        pageSize: options.pageSize,
        total,
        totalPages: Math.ceil(total / options.pageSize),
      },
    };
  }
}
