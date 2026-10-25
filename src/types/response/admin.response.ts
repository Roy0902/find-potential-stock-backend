import type { AuthorSummary, CommentSummary } from './comments.response.js';

export type AdminComment = Omit<CommentSummary, 'author'> & {
  author: AuthorSummary & { id: number };
  isHidden: boolean;
  hiddenReason: string | null;
};

export type AdminAction = {
  id: number;
  action: string;
  targetType: string;
  targetId: number;
  createdAt: string;
};

export type ScrapeRun = {
  id: number;
  mode: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  commentsAdded: number;
  commentsUpdated: number;
  commentsSkippedRestricted: number;
  logFile: string | null;
  errorCount: number;
  stopReason: string | null;
};
