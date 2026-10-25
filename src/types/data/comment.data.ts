export type CommentNode = {
  id: number;
  parentId: number | null;
  parentMissing: boolean;
  replyTargetUnknown: boolean;
  body: string;
  postedAt: string;
  url: string;
  lang: string | null;
  author: { displayName: string; externalId: string };
  depth: number;
  collapsed: boolean;
  children: CommentNode[];
};

/** Row shape returned by the public comment queries. */
export type CommentRow = {
  id: number;
  body: string;
  posted_at: Date;
  url: string;
  thread_id: number;
  thread_title: string;
  source_name: string;
  external_id: string;
  display_name: string;
  is_blocked: boolean;
  parent_id: number | null;
  reply_target_unknown: boolean;
};

/** Row shape returned by the thread tree query. */
export type ThreadCommentRow = {
  id: number;
  parent_id: number | null;
  parent_external_id: string | null;
  reply_target_unknown: boolean;
  body: string;
  posted_at: Date;
  url: string;
  lang: string | null;
  display_name: string;
  author_external_id: string;
  is_hidden: boolean;
  is_blocked: boolean;
};
