export type ThreadRouteParams = { threadId: number };

export type ThreadRouteQuery = {
  commentId?: number;
  page?: number;
  pageSize?: number;
};
