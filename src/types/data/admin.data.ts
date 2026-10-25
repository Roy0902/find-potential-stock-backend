/** Row shape returned by the admin comment queries. */
export type AdminCommentRow = {
  id: number;
  author_id: number;
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
  is_hidden: boolean;
  hidden_reason: string | null;
};
