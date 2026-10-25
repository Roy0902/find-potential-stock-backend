export type AdminIdParams = { id: number };

export type AdminCommentListQuery = {
  q?: string;
  author?: string;
  source?: string;
  page?: number;
  pageSize?: number;
};

export type AdminLimitQuery = { limit?: number };

export type AdminHiddenBody = { hidden?: boolean };

export type LoginBody = { username?: string; password?: string };
