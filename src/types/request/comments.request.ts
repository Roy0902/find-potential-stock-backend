/** Query accepted by GET /api/comments (values may be omitted). */
export type CommentsRouteQuery = {
  page?: number;
  pageSize?: number;
  forumId?: number;
  search?: string;
};

/** Query after route defaults are applied, as the repository expects it. */
export type ListCommentsQuery = {
  page: number;
  pageSize: number;
  forumId?: number;
  search?: string;
};
