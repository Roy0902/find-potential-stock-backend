export type ScrapeRunStatus = 'running' | 'success' | 'partial' | 'failed';
export type ScrapeRunMode = 'backfill' | 'incremental';
export type ScrapeLogLevel = 'info' | 'warning' | 'error';

export type LihkgUser = {
  user_id: number;
  nickname?: string;
};

export type LihkgThreadItem = {
  post_id: string;
  msg_num: number;
  page: number;
  msg: string;
  reply_time: number;
  status?: number;
  user?: LihkgUser | null;
  user_nickname?: string;
  quote_post_id?: string;
  no_of_quote?: number;
};

export type LihkgThreadMeta = {
  thread_id: number;
  title: string;
  status: number;
  no_of_reply: number;
  total_page: number;
  max_reply?: number;
  category?: { cat_id: number; name: string } | null;
  user?: LihkgUser | null;
  user_nickname?: string;
  create_time?: number;
};

export type LihkgThreadFile = {
  success: number;
  response: LihkgThreadMeta & { item_data?: LihkgThreadItem[] };
  _scrape?: {
    method?: string;
    scraped_at?: string;
    source_url?: string;
    keyword?: string;
    pages_captured?: number[];
    pages_expected?: number;
    comments_captured?: number;
    op_included?: boolean;
    incomplete?: boolean;
    error?: string | null;
  };
};

export type ScrapeRunRow = {
  id: number;
  source_id: number;
  mode: string;
  started_at: Date;
  finished_at: Date | null;
  status: string;
  comments_added: number;
  comments_updated: number;
  comments_skipped_restricted: number;
  log_file: string | null;
  error_count: number;
  stop_reason: string | null;
};

export type IngestThreadResult = {
  threadId: number;
  added: number;
  seen: number;
  skippedRestricted: number;
  hidden: number;
};
