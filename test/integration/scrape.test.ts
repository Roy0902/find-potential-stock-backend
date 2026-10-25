import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config.js';
import { createDatabase, type Database } from '../../src/db.js';
import { IngestRepository } from '../../src/repository/ingestRepository.js';
import { ScrapeRepository } from '../../src/repository/scrapeRepository.js';
import type { LihkgThreadFile, LihkgThreadItem } from '../../src/types/data/scrape.data.js';

const SOURCE = 9951;
const config = loadConfig();
const db: Database = createDatabase(config);
const dbUp = await db.isAvailable();
const ingest = new IngestRepository(db);
const runs = new ScrapeRepository(db);

const ITEMS: LihkgThreadItem[] = [
  {
    post_id: 'p1',
    msg_num: 2,
    page: 1,
    msg: 'hello <b>world</b> &amp; more',
    reply_time: 1_790_000_000,
    status: 1,
    user: { user_id: 1, nickname: 'Alice' },
    user_nickname: 'Alice',
  },
  {
    post_id: 'p2',
    msg_num: 3,
    page: 1,
    msg: '回覆 <br> 第二行',
    reply_time: 1_790_000_060,
    status: 1,
    user: { user_id: 2, nickname: 'Bob' },
    user_nickname: 'Bob',
    quote_post_id: 'p1',
  },
];

const P3: LihkgThreadItem = {
  post_id: 'p3',
  msg_num: 4,
  page: 1,
  msg: 'third comment',
  reply_time: 1_790_000_120,
  status: 1,
  user: { user_id: 1, nickname: 'Alice' },
  user_nickname: 'Alice',
};

function threadFile(items: LihkgThreadItem[] = ITEMS): LihkgThreadFile {
  return {
    success: 1,
    response: {
      thread_id: 900001,
      title: 'Scrape fixture thread',
      status: 1,
      no_of_reply: items.length,
      total_page: 1,
      max_reply: 1001,
      category: { cat_id: 1, name: '財經台' },
      item_data: items,
    },
    _scrape: { incomplete: false, error: null, pages_captured: [1], pages_expected: 1 },
  };
}

async function cleanup() {
  const existing = await db.query<{ name: string }>('SELECT name FROM source WHERE id = $1', [
    SOURCE,
  ]);
  if (existing.rows[0] && existing.rows[0].name !== 'ScrapeFixture') {
    throw new Error(
      `refusing to delete source ${SOURCE} (${existing.rows[0].name}); it is not the test fixture`,
    );
  }
  await db.query('DELETE FROM comment WHERE source_id = $1', [SOURCE]);
  await db.query('DELETE FROM thread WHERE source_id = $1', [SOURCE]);
  await db.query('DELETE FROM author WHERE source_id = $1', [SOURCE]);
  await db.query('DELETE FROM scrape_run WHERE source_id = $1', [SOURCE]);
  await db.query('DELETE FROM source WHERE id = $1', [SOURCE]);
}

before(async () => {
  if (!dbUp) return;
  await cleanup();
  await db.query(
    "INSERT INTO source (id, name, base_url, enabled) VALUES ($1, 'ScrapeFixture', 'https://fixture.test', false)",
    [SOURCE],
  );
});

after(async () => {
  if (dbUp) await cleanup();
  await db.end();
});

describe('scrape ingestion', { skip: !dbUp ? 'database unavailable' : false }, () => {
  test('inserts the thread, authors and comments with decoded bodies', async () => {
    const result = await ingest.ingestThread(threadFile(), SOURCE, new Date());

    assert.equal(result.added, 2);
    assert.equal(result.seen, 2);
    assert.equal(result.skippedRestricted, 0);
    assert.equal(result.hidden, 0);

    const thread = await db.query<{ id: number; title: string; board: string; url: string }>(
      'SELECT id, title, board, url FROM thread WHERE source_id = $1 AND external_id = $2',
      [SOURCE, '900001'],
    );
    assert.equal(thread.rows.length, 1);
    assert.equal(thread.rows[0]!.title, 'Scrape fixture thread');
    assert.equal(thread.rows[0]!.board, '財經台');
    assert.equal(thread.rows[0]!.url, 'https://lihkg.com/thread/900001');

    const comments = await db.query<{
      id: number;
      external_id: string;
      body: string;
      lang: string;
      parent_id: number | null;
      reply_target_unknown: boolean;
      url: string;
      is_hidden: boolean;
    }>(
      `SELECT id, external_id, body, lang, parent_id, reply_target_unknown, url, is_hidden
         FROM comment
        WHERE source_id = $1
        ORDER BY external_id`,
      [SOURCE],
    );
    assert.equal(comments.rows.length, 2);

    const p1 = comments.rows[0]!;
    const p2 = comments.rows[1]!;
    assert.equal(p1.external_id, 'p1');
    assert.equal(p1.body, 'hello world & more');
    assert.equal(p1.lang, 'en');
    assert.equal(p1.parent_id, null);
    assert.equal(p1.url, 'https://lihkg.com/thread/900001/page/1#p1');

    assert.equal(p2.external_id, 'p2');
    assert.equal(p2.body, '回覆\n第二行');
    assert.equal(p2.lang, 'zh-HK');
    assert.equal(p2.parent_id, p1.id);
    assert.equal(p2.reply_target_unknown, false);
  });

  test('re-ingesting inserts nothing and refreshes last_seen_at', async () => {
    const before = await db.query<{ last_seen_at: Date }>(
      "SELECT last_seen_at FROM comment WHERE source_id = $1 AND external_id = 'p1'",
      [SOURCE],
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    const result = await ingest.ingestThread(threadFile(), SOURCE, new Date());

    assert.equal(result.added, 0);
    assert.equal(result.seen, 2);
    const after = await db.query<{ last_seen_at: Date }>(
      "SELECT last_seen_at FROM comment WHERE source_id = $1 AND external_id = 'p1'",
      [SOURCE],
    );
    assert.ok(after.rows[0]!.last_seen_at >= before.rows[0]!.last_seen_at);
  });

  test('adds only the comments that are new', async () => {
    const result = await ingest.ingestThread(threadFile([...ITEMS, P3]), SOURCE, new Date());

    assert.equal(result.added, 1);
    assert.equal(result.seen, 3);
  });

  test('hides a stored comment that disappeared from a complete scrape', async () => {
    const withoutP2 = threadFile([ITEMS[0]!, P3]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const runStartedAt = new Date();

    const result = await ingest.ingestThread(withoutP2, SOURCE, runStartedAt);

    assert.equal(result.hidden, 1);
    const row = await db.query<{ is_hidden: boolean; hidden_reason: string | null }>(
      "SELECT is_hidden, hidden_reason FROM comment WHERE source_id = $1 AND external_id = 'p2'",
      [SOURCE],
    );
    assert.equal(row.rows[0]!.is_hidden, true);
    assert.equal(row.rows[0]!.hidden_reason, 'source_removed');
  });

  test('does not hide anything when the scrape is incomplete', async () => {
    const incomplete = threadFile([]);
    incomplete._scrape = { incomplete: true, error: 'timeout' };

    const result = await ingest.ingestThread(incomplete, SOURCE, new Date());

    assert.equal(result.hidden, 0);
    const row = await db.query<{ is_hidden: boolean }>(
      "SELECT is_hidden FROM comment WHERE source_id = $1 AND external_id = 'p3'",
      [SOURCE],
    );
    assert.equal(row.rows[0]!.is_hidden, false);
  });

  test('keeps an admin-hidden comment hidden with its original reason', async () => {
    await db.query(
      "UPDATE comment SET is_hidden = true, hidden_reason = 'admin' WHERE source_id = $1 AND external_id = 'p1'",
      [SOURCE],
    );

    const result = await ingest.ingestThread(threadFile([ITEMS[1]!, P3]), SOURCE, new Date());

    assert.equal(result.hidden, 0);
    const row = await db.query<{ is_hidden: boolean; hidden_reason: string | null }>(
      "SELECT is_hidden, hidden_reason FROM comment WHERE source_id = $1 AND external_id = 'p1'",
      [SOURCE],
    );
    assert.equal(row.rows[0]!.is_hidden, true);
    assert.equal(row.rows[0]!.hidden_reason, 'admin');
  });

  test('marks a missing quoted parent as an unknown reply target', async () => {
    const orphan: LihkgThreadItem = {
      post_id: 'p4',
      msg_num: 5,
      page: 1,
      msg: 'reply to something not scraped',
      reply_time: 1_790_000_180,
      status: 1,
      user: { user_id: 3, nickname: 'Carol' },
      user_nickname: 'Carol',
      quote_post_id: 'missing',
    };
    await ingest.ingestThread(threadFile([ITEMS[0]!, orphan]), SOURCE, new Date());

    const row = await db.query<{ parent_id: number | null; reply_target_unknown: boolean }>(
      "SELECT parent_id, reply_target_unknown FROM comment WHERE source_id = $1 AND external_id = 'p4'",
      [SOURCE],
    );
    assert.equal(row.rows[0]!.parent_id, null);
    assert.equal(row.rows[0]!.reply_target_unknown, true);
  });
});

describe('scrape run records', { skip: !dbUp ? 'database unavailable' : false }, () => {
  test('creates, finishes and reads a run', async () => {
    const id = await runs.createRun(SOURCE, 'incremental', 'logs/scraper/log_1.txt');
    const running = await runs.getRun(id);
    assert.equal(running?.status, 'running');
    assert.equal(running?.log_file, 'logs/scraper/log_1.txt');
    assert.equal(running?.error_count, 0);

    await runs.finishRun(id, {
      status: 'success',
      commentsAdded: 4,
      commentsUpdated: 0,
      commentsSkippedRestricted: 1,
      logFile: 'logs/scraper/log_1.txt',
      errorCount: 0,
      stopReason: 'completed',
    });

    const finished = await runs.getRun(id);
    assert.equal(finished?.status, 'success');
    assert.equal(finished?.comments_added, 4);
    assert.equal(finished?.comments_skipped_restricted, 1);
    assert.equal(finished?.stop_reason, 'completed');
    assert.ok(finished?.finished_at);
    assert.equal(await runs.findRunning(), null);
  });

  test('allows only one running run at a time', async () => {
    const first = await runs.createRun(SOURCE, 'incremental', null);
    await assert.rejects(() => runs.createRun(SOURCE, 'incremental', null));

    await runs.finishRun(first, {
      status: 'success',
      commentsAdded: 0,
      commentsUpdated: 0,
      commentsSkippedRestricted: 0,
      logFile: null,
      errorCount: 0,
      stopReason: 'completed',
    });
  });

  test('closes a stale running row as failed', async () => {
    const id = await runs.createRun(SOURCE, 'incremental', null);
    await db.query(
      "UPDATE scrape_run SET started_at = now() - interval '10 minutes' WHERE id = $1",
      [id],
    );

    const changed = await runs.markStaleFailed(5);

    assert.ok(changed >= 1);
    const row = await runs.getRun(id);
    assert.equal(row?.status, 'failed');
    assert.equal(row?.stop_reason, 'stale');
    assert.equal(row?.error_count, 1);
  });
});
