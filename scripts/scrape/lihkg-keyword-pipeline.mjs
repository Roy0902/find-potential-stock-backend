/**
 * LIHKG keyword pipeline.
 *
 * 1. Searches LIHKG for a keyword, newest threads first (`sort=desc_create_time`).
 * 2. Takes the first N results (N = CONFIG.limit).
 * 3. Scrapes each thread's comments (all pages, raw API response shape).
 * 4. If a thread is archived (status 4) AND has >= 1000 replies, it is scraped,
 *    marked completed, and the run stops.
 *
 * Search must run inside the browser: LIHKG rejects anonymous Node fetches with
 * error_code 5, but the same request works from a page context with cookies.
 *
 * Usage (all settings live in CONFIG below):
 *   node scripts/scrape/lihkg-keyword-pipeline.mjs
 *
 * Optional CLI overrides:
 *   node scripts/scrape/lihkg-keyword-pipeline.mjs "keyword" --limit 3 --csv --headed
 *
 * Options: --limit, --sort, --cat-id, --delay, --out, --csv, --headed,
 *          --include-op, --json-logs, --stop-on-complete, --no-stop-on-complete
 *
 * --json-logs prints one JSON object per line on stdout. The backend scheduler uses it to
 * stream progress, warnings and errors into logs/scraper/log_{n}.txt.
 */
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Edit these instead of passing flags.
// ---------------------------------------------------------------------------
const CONFIG = {
  keyword: '劇',
  limit: 10, // first N threads to process, newest first
  sort: 'desc_create_time', // 'desc_create_time' (newest posts) or 'desc_reply_time'
  catId: null, // null = all categories
  includeOp: false, // include floor 1 in item_data
  delayMs: 4000, // pause between requests
  pageTimeoutMs: 30_000, // per-page API wait
  maxSearchPages: 10, // safety cap while collecting N threads
  searchCount: 30, // search results per page
  outDir: 'scrape-output/lihkg/keywords',
  csv: false,
  headed: false,
  jsonLogs: false,
  // The scheduled job re-scrapes every thread and inserts only new comments, so it
  // disables the "stop after an archived 1000+ reply thread" shortcut.
  stopOnComplete: false,
};

// A thread is "completed" when it is archived and big enough.
const COMPLETION = {
  archivedStatus: 4, // LIHKG thread status: 1 active, 2 suspend, 3 deleted, 4 archive
  minReplies: 1000,
};
// ---------------------------------------------------------------------------

const VALID_SORTS = ['desc_create_time', 'desc_reply_time', 'score'];
const args = process.argv.slice(2);
const overrides = {};
let keywordArg = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--limit') overrides.limit = Number(args[++i]);
  else if (arg === '--sort') overrides.sort = args[++i];
  else if (arg === '--cat-id') overrides.catId = Number(args[++i]);
  else if (arg === '--delay') overrides.delayMs = Number(args[++i]);
  else if (arg === '--out') overrides.outDir = args[++i];
  else if (arg === '--csv') overrides.csv = true;
  else if (arg === '--headed') overrides.headed = true;
  else if (arg === '--include-op') overrides.includeOp = true;
  else if (arg === '--json-logs') overrides.jsonLogs = true;
  else if (arg === '--stop-on-complete') overrides.stopOnComplete = true;
  else if (arg === '--no-stop-on-complete') overrides.stopOnComplete = false;
  else keywordArg = arg;
}

const cfg = { ...CONFIG, ...overrides };
if (keywordArg) cfg.keyword = keywordArg;

if (!cfg.keyword) {
  console.error('No keyword configured. Set CONFIG.keyword or pass one as the first argument.');
  process.exit(1);
}
if (!VALID_SORTS.includes(cfg.sort)) {
  console.error(`Invalid sort "${cfg.sort}". Use one of: ${VALID_SORTS.join(', ')}`);
  process.exit(1);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const log = (level, message, extra = {}) => {
  if (cfg.jsonLogs) {
    process.stdout.write(`${JSON.stringify({ level, message, ...extra })}\n`);
    return;
  }
  const label = level === 'warning' ? 'Warning' : level === 'error' ? 'Error' : 'Info';
  const line = `[${label}] ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warning') console.warn(line);
  else console.log(line);
};
const logInfo = (message, extra) => log('info', message, extra);
const logWarning = (message, extra) => log('warning', message, extra);
const logError = (message, extra) => log('error', message, extra);

function safeDirName(name) {
  return (
    name
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/\s+/g, '_')
      .slice(0, 80) || 'keyword'
  );
}

function decodeHtml(text = '') {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const outDir = path.resolve(cfg.outDir, safeDirName(cfg.keyword));
const stateFile = path.join(outDir, 'state.json');
await fs.mkdir(outDir, { recursive: true });

let state = {
  keyword: cfg.keyword,
  sort: cfg.sort,
  updated_at: new Date().toISOString(),
  threads: {},
};
try {
  state = { ...state, ...JSON.parse(await fs.readFile(stateFile, 'utf8')) };
} catch {
  // First run for this keyword.
}
state.keyword = cfg.keyword;
state.sort = cfg.sort;

async function saveState(extra = {}) {
  state.updated_at = new Date().toISOString();
  Object.assign(state, extra);
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2), 'utf8');
}

const browser = await chromium.launch({ headless: !cfg.headed });
const context = await browser.newContext({
  locale: 'zh-HK',
  timezoneId: 'Asia/Hong_Kong',
  viewport: { width: 1280, height: 900 },
});
const page = await context.newPage();

// Keep the browser light: no images/media/fonts or ad/tracker calls.
const blockedHost =
  /(taboola|doubleclick|googlesyndication|adtrafficquality|bidmyqps|appier|rubiconproject|vidstat|adv\.lihkg\.com)/i;
await page.route('**/*', route => {
  const request = route.request();
  const type = request.resourceType();
  if (type === 'image' || type === 'media' || type === 'font' || blockedHost.test(request.url())) {
    return route.abort();
  }
  return route.continue();
});

/** @type {Map<string, any>} key: `${threadId}:${page}` */
const captured = new Map();
let apiError = null;

page.on('response', response => {
  const match = response.url().match(/\/api_v2\/thread\/(\d+)\/page\/(\d+)/);
  if (!match) return;

  const threadId = Number(match[1]);
  const pageNumber = Number(match[2]);
  const status = response.status();

  if (status === 429 || status >= 400) {
    const retryAfter = Number(response.headers()['retry-after']);
    apiError = {
      threadId,
      page: pageNumber,
      status,
      retryAfter: Number.isFinite(retryAfter) ? retryAfter : null,
    };
    return;
  }

  response
    .json()
    .then(payload => captured.set(`${threadId}:${pageNumber}`, payload))
    .catch(() => {
      // Body unavailable; the wait below will time out.
    });
});

function rateLimitError(info) {
  const wait = info.retryAfter ? ` Retry-After: ${info.retryAfter}s.` : '';
  const error = new Error(`Rate limited (HTTP ${info.status}) on thread ${info.threadId} page ${info.page}.${wait}`);
  error.rateLimited = true;
  return error;
}

async function waitForThreadPage(threadId, pageNumber) {
  const key = `${threadId}:${pageNumber}`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < cfg.pageTimeoutMs) {
    if (captured.has(key)) return captured.get(key);
    if (apiError && apiError.threadId === threadId && apiError.page === pageNumber) {
      if (apiError.status === 429) throw rateLimitError(apiError);
      throw new Error(`LIHKG returned HTTP ${apiError.status} for thread ${threadId} page ${pageNumber}`);
    }
    await sleep(250);
  }
  throw new Error(`Timed out after ${cfg.pageTimeoutMs}ms waiting for thread ${threadId} page ${pageNumber}`);
}

async function openThreadPage(threadId, pageNumber) {
  apiError = null;
  await page.goto(`https://lihkg.com/thread/${threadId}/page/${pageNumber}`, {
    waitUntil: 'domcontentloaded',
    timeout: cfg.pageTimeoutMs + 30_000,
  });
  return waitForThreadPage(threadId, pageNumber);
}

async function fetchSearchPage(pageNumber, attempt = 1) {
  const url = new URL('https://lihkg.com/api_v2/thread/search');
  url.searchParams.set('q', cfg.keyword);
  url.searchParams.set('page', String(pageNumber));
  url.searchParams.set('count', String(cfg.searchCount));
  url.searchParams.set('sort', cfg.sort);
  url.searchParams.set('type', 'thread');
  if (cfg.catId != null) url.searchParams.set('cat_id', String(cfg.catId));

  const result = await page.evaluate(async href => {
    const response = await fetch(href, {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Non-JSON response (Cloudflare block page).
    }
    return {
      status: response.status,
      retryAfter: Number(response.headers.get('retry-after')) || null,
      json,
      text: text.slice(0, 200),
    };
  }, url.href);

  if (result.status === 429) {
    const error = new Error(`Search rate limited (HTTP 429). Retry-After: ${result.retryAfter ?? 'unknown'}s.`);
    error.rateLimited = true;
    if (result.retryAfter && result.retryAfter <= 120 && attempt < 3) {
      logWarning(`search page ${pageNumber}: 429, waiting ${result.retryAfter}s before retry`);
      await sleep(result.retryAfter * 1000);
      return fetchSearchPage(pageNumber, attempt + 1);
    }
    throw error;
  }
  if (!result.json || result.json.success !== 1) {
    const detail = result.json?.error_message ?? result.text;
    throw new Error(`Search failed on page ${pageNumber}: ${detail}`);
  }
  return result.json;
}

async function collectSearchResults() {
  logInfo(`Searching "${cfg.keyword}" (${cfg.sort}) ...`);
  await page.goto(
    `https://lihkg.com/search?q=${encodeURIComponent(cfg.keyword)}&sort=${encodeURIComponent(cfg.sort)}`,
    { waitUntil: 'domcontentloaded', timeout: cfg.pageTimeoutMs + 30_000 },
  );
  await page.waitForTimeout(2000);

  const items = [];
  const seen = new Set();
  let pageNumber = 1;

  while (items.length < cfg.limit && pageNumber <= cfg.maxSearchPages) {
    const payload = await fetchSearchPage(pageNumber);
    const pageItems = payload.response?.items ?? [];
    let added = 0;

    for (const item of pageItems) {
      if (items.length >= cfg.limit) break;
      if (seen.has(item.thread_id)) continue;
      seen.add(item.thread_id);
      // Deleted threads cannot be scraped.
      if (item.status === 3) continue;
      items.push(item);
      added++;
    }

    logInfo(
      `search page ${pageNumber}: ${pageItems.length} result(s), ${added} kept (${items.length}/${cfg.limit})`,
    );

    if (!payload.response?.is_pagination || pageItems.length === 0) break;
    if (items.length >= cfg.limit) break;

    pageNumber++;
    await sleep(1000);
  }

  return items.slice(0, cfg.limit);
}

function mergeItems(items) {
  const seen = new Set();
  return items
    .filter(item => (seen.has(item.post_id) ? false : seen.add(item.post_id)))
    .filter(item => (cfg.includeOp ? true : item.msg_num !== 1))
    .sort((a, b) => a.msg_num - b.msg_num);
}

async function saveThreadResult(threadId, meta, rawItems, pagesCaptured, expectedPages, status) {
  const merged = mergeItems(rawItems);
  const result = {
    success: 1,
    response: {
      ...meta,
      page: pagesCaptured.at(-1) ?? 1,
      item_data: merged,
    },
    _scrape: {
      method: 'playwright-intercept',
      scraped_at: new Date().toISOString(),
      source_url: `https://lihkg.com/thread/${threadId}`,
      keyword: cfg.keyword,
      pages_captured: pagesCaptured,
      pages_expected: expectedPages,
      comments_captured: merged.length,
      op_included: cfg.includeOp,
      incomplete: status.incomplete,
      error: status.error ?? null,
    },
  };

  const file = path.join(outDir, `thread-${threadId}-comments.json`);
  await fs.writeFile(file, JSON.stringify(result, null, 2), 'utf8');
  return { result, merged, file };
}

async function scrapeThread(thread) {
  const threadId = thread.thread_id;
  const rawItems = [];
  const pagesCaptured = [];
  let meta = null;
  let expectedPages = 0;
  let failure = null;
  let failedPage = null;

  try {
    const first = await openThreadPage(threadId, 1);
    meta = first.response;

    // Completeness is positive evidence, never "the loop did not throw". A missing or
    // nonsensical total_page would otherwise make a single-page file look complete and
    // let the importer hide every comment on the later pages.
    const declaredPages = Number(meta.total_page);
    if (!Number.isInteger(declaredPages) || declaredPages < 1) {
      failure = `invalid total_page (${meta.total_page})`;
    } else {
      expectedPages = declaredPages;
    }

    const firstItems = meta.item_data ?? [];
    rawItems.push(...firstItems);
    pagesCaptured.push(1);

    if (failure === null && firstItems.length === 0 && Number(meta.no_of_reply) > 0) {
      failure = 'page 1 returned 0 comments';
    }

    const terminal =
      [2, 3, 4].includes(meta.status) ||
      (Number.isFinite(meta.max_reply) && meta.no_of_reply >= meta.max_reply);
    logInfo(
      `thread ${threadId} ${meta.title} | ${meta.no_of_reply} replies, ` +
        `${expectedPages || '?'} page(s), status ${meta.status}${terminal ? ' (terminal)' : ''}`,
    );

    await saveThreadResult(threadId, meta, rawItems, pagesCaptured, expectedPages, {
      incomplete: failure !== null || expectedPages > 1,
      error: failure,
    });

    for (let pageNumber = 2; failure === null && pageNumber <= expectedPages; pageNumber++) {
      await sleep(cfg.delayMs);
      const payload = await openThreadPage(threadId, pageNumber);
      const pageItems = payload.response.item_data ?? [];
      rawItems.push(...pageItems);
      pagesCaptured.push(pageNumber);
      logInfo(`page ${pageNumber}: +${pageItems.length} comments`);

      if (pageItems.length === 0) {
        failure = `page ${pageNumber} returned 0 comments`;
        break;
      }

      await saveThreadResult(threadId, meta, rawItems, pagesCaptured, expectedPages, {
        incomplete: pageNumber < expectedPages,
        error: failure,
      });
    }
  } catch (error) {
    failure = error.message;
    failedPage = pagesCaptured.length + 1;
    logWarning(`stopped thread ${threadId}: ${failure}`);
  }

  if (!meta) {
    return {
      ok: false,
      rateLimited: Boolean(failure && /Rate limited/.test(failure)),
      error: failure,
      merged: [],
      result: null,
    };
  }

  const complete =
    failure === null &&
    expectedPages >= 1 &&
    pagesCaptured.length === expectedPages;

  const { result, merged, file } = await saveThreadResult(threadId, meta, rawItems, pagesCaptured, expectedPages, {
    incomplete: !complete,
    error: failure,
  });

  return {
    ok: complete,
    rateLimited: Boolean(failure && /Rate limited/.test(failure)),
    error: failure,
    failedPage,
    result,
    merged,
    file,
  };
}

const startedAt = new Date().toISOString();
let stopReason = 'exhausted';
let rateLimited = false;
const csvRows = [];
let processed = 0;

try {
  const queue = await collectSearchResults();
  if (queue.length === 0) {
    logInfo('No usable search results.');
    stopReason = 'no-results';
  } else {
    logInfo(`Processing ${queue.length} thread(s), newest first.`);
  }

  for (const thread of queue) {
    if (processed >= cfg.limit) {
      stopReason = 'limit';
      break;
    }

    const isCompleted = thread.status === COMPLETION.archivedStatus && thread.no_of_reply >= COMPLETION.minReplies;

    processed++;
    logInfo(
      `[${processed}/${queue.length}] thread ${thread.thread_id} | replies ${thread.no_of_reply} | status ${thread.status}${isCompleted ? ' | ARCHIVED/FULL' : ''}`,
    );

    const outcome = await scrapeThread(thread);
    const markedCompleted = isCompleted && outcome.ok;

    state.threads[thread.thread_id] = {
      thread_id: thread.thread_id,
      title: thread.title,
      status: outcome.result?.response?.status ?? thread.status,
      no_of_reply: outcome.result?.response?.no_of_reply ?? thread.no_of_reply,
      total_page: outcome.result?.response?.total_page ?? thread.total_page,
      comments_saved: outcome.merged.length,
      completed: markedCompleted,
      incomplete: !outcome.ok,
      error: outcome.error,
      last_run: new Date().toISOString(),
    };
    await saveState();

    if (outcome.merged.length > 0) {
      for (const item of outcome.merged) {
        csvRows.push({
          keyword: cfg.keyword,
          thread_id: thread.thread_id,
          thread_title: outcome.result.response.title,
          post_id: item.post_id,
          floor: item.msg_num,
          author_id: item.user?.user_id,
          author_nickname: item.user_nickname,
          posted_at: item.reply_time ? new Date(item.reply_time * 1000).toISOString() : '',
          like_count: item.like_count,
          dislike_count: item.dislike_count,
          text: decodeHtml(item.msg),
        });
      }
    }

    if (outcome.rateLimited) {
      rateLimited = true;
      stopReason = 'rate-limited';
      logError('Rate limited by Cloudflare; stopping the run. Progress is saved.');
      break;
    }

    if (isCompleted) {
      if (!markedCompleted) {
        logWarning(
          `Thread ${thread.thread_id} matches the completion rule but the scrape failed; not marking completed.`,
        );
      } else if (cfg.stopOnComplete) {
        logInfo(
          `Thread ${thread.thread_id} is archived with ${thread.no_of_reply} replies ` +
            `(>= ${COMPLETION.minReplies}); marked completed, stopping run.`,
        );
        stopReason = 'completed';
        break;
      } else {
        logInfo(
          `Thread ${thread.thread_id} is archived/full; continuing because stop-on-complete is disabled.`,
        );
      }
    }

    await sleep(cfg.delayMs);
  }

  if (stopReason === 'exhausted' && processed >= cfg.limit) {
    stopReason = 'limit';
  }
} catch (error) {
  logError(`Fatal: ${error.message}`);
  if (/rate limited/i.test(error.message)) {
    rateLimited = true;
    stopReason = 'rate-limited';
  } else {
    stopReason = 'error';
  }
} finally {
  await browser.close();
}

if (cfg.csv && csvRows.length > 0) {
  const quote = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const header = [
    'keyword',
    'thread_id',
    'thread_title',
    'post_id',
    'floor',
    'author_id',
    'author_nickname',
    'posted_at',
    'like_count',
    'dislike_count',
    'text',
  ];
  const lines = [header.map(quote).join(',')];
  for (const row of csvRows) lines.push(header.map(key => quote(row[key])).join(','));

  const csvFile = path.join(outDir, 'comments.csv');
  await fs.writeFile(csvFile, `\uFEFF${lines.join('\r\n')}`, 'utf8');
  logInfo(`CSV -> ${csvFile}`);
}

await saveState({
  last_run: {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    stop_reason: stopReason,
    rate_limited: rateLimited,
    threads_processed: processed,
    comments_saved: csvRows.length,
    config: {
      keyword: cfg.keyword,
      limit: cfg.limit,
      sort: cfg.sort,
      cat_id: cfg.catId,
      delay_ms: cfg.delayMs,
    },
  },
});

logInfo(
  `Stopped: ${stopReason}. ${processed} thread(s), ${csvRows.length} comment(s).`,
  {
    stopReason,
    threadsProcessed: processed,
    commentsSaved: csvRows.length,
    rateLimited,
  },
);
logInfo(`State -> ${stateFile}`);
logInfo(`Output -> ${outDir}`);

// The scheduler treats a non-zero exit as a failed run even if the script caught the error.
if (stopReason === 'error') {
  process.exitCode = 1;
}
