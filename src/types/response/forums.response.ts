export type ForumSummary = {
  id: number;
  name: string;
  commentCount: number;
};

export type ForumListResponse = {
  forums: ForumSummary[];
};
