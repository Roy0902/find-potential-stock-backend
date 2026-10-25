import type { CommentNode, ThreadCommentRow } from '../types/data/comment.data.js';

const MAX_DEPTH = 5;

function byTime(a: ThreadCommentRow, b: ThreadCommentRow): number {
  const diff = new Date(a.posted_at).getTime() - new Date(b.posted_at).getTime();
  return diff !== 0 ? diff : a.id - b.id;
}

/**
 * Build the public tree: hidden comments and blocked authors are dropped, their replies
 * move to the nearest visible ancestor, missing parents surface at the top, and branches
 * below level 5 are replaced by a source link.
 */
export function buildTree(rows: ThreadCommentRow[]): CommentNode[] {
  const visible = rows.filter((row) => !row.is_hidden && !row.is_blocked);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const visibleIds = new Set(visible.map((row) => row.id));

  const parentKey = new Map<number, number | null>();
  const parentMissing = new Map<number, boolean>();

  for (const row of visible) {
    let parentId = row.parent_id;
    while (parentId !== null && !visibleIds.has(parentId)) {
      parentId = byId.get(parentId)?.parent_id ?? null;
    }
    parentKey.set(row.id, parentId);
    parentMissing.set(
      row.id,
      parentId === null && row.parent_id === null && row.parent_external_id !== null,
    );
  }

  const children = new Map<number | null, ThreadCommentRow[]>();
  for (const row of visible) {
    const key = parentKey.get(row.id) ?? null;
    const list = children.get(key) ?? [];
    list.push(row);
    children.set(key, list);
  }
  for (const list of children.values()) list.sort(byTime);

  const build = (row: ThreadCommentRow, depth: number): CommentNode => {
    const kids = children.get(row.id) ?? [];
    const capped = depth >= MAX_DEPTH && kids.length > 0;
    return {
      id: row.id,
      parentId: row.parent_id,
      parentMissing: parentMissing.get(row.id) ?? false,
      replyTargetUnknown: row.reply_target_unknown,
      body: row.body,
      postedAt: new Date(row.posted_at).toISOString(),
      url: row.url,
      lang: row.lang,
      author: { displayName: row.display_name, externalId: row.author_external_id },
      depth,
      collapsed: capped,
      children: capped ? [] : kids.map((kid) => build(kid, depth + 1)),
    };
  };

  return (children.get(null) ?? []).map((row) => build(row, 1));
}
