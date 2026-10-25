/** Response shapes of the public API. Field names come from Spec/data-model.md. */

export type AuthorSummary = {
  displayName: string;
  externalId: string;
  isBlocked: boolean;
};

export type CommentSummary = {
  id: number;
  body: string;
  postedAt: string;
  url: string;
  threadId: number;
  threadTitle: string;
  sourceName: string;
  author: AuthorSummary;
  parentId: number | null;
  replyTargetUnknown: boolean;
  /** First 200 characters of the body (Spec/website-spec.md D2). */
  excerpt: string;
};

export type Pagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type CommentListResponse = {
  comments: CommentSummary[];
  pagination: Pagination;
};
