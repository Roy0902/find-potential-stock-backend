import type { CommentNode } from '../data/comment.data.js';
import type { ThreadMeta } from '../data/thread.data.js';
import type { Pagination } from './comments.response.js';

export type ThreadPage = {
  thread: ThreadMeta;
  highlightedCommentId: number | null;
  comments: CommentNode[];
  topLevel: Pagination;
};
