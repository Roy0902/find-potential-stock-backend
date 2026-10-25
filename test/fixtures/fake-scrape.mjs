import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Stand-in for lihkg-keyword-pipeline.mjs in runner tests: no browser, no network.
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outDir = args[outIndex + 1];
if (!outDir) {
  console.error('fake-scrape: --out is required');
  process.exit(2);
}

// Mirror the real pipeline, which writes under <out>/<keyword>/.
const keywordDir = join(outDir, 'test-keyword');
await mkdir(keywordDir, { recursive: true });

const mode = process.env.FAKE_SCRAPE_MODE ?? 'ok';
const thread = {
  success: 1,
  response: {
    thread_id: 900001,
    title: 'Fake thread',
    status: mode === 'deleted' ? 3 : 1,
    no_of_reply: 1,
    total_page: 1,
    max_reply: 1001,
    category: { cat_id: 1, name: '財經台' },
    item_data: [
      {
        post_id: 'p1',
        msg_num: 2,
        page: 1,
        msg: 'hello <b>world</b>',
        reply_time: 1790000000,
        status: 1,
        user: { user_id: 1, nickname: 'Alice' },
        user_nickname: 'Alice',
      },
    ],
  },
  _scrape: {
    incomplete: mode === 'incomplete',
    error: null,
    pages_captured: [1],
    pages_expected: 1,
  },
};

await writeFile(
  join(keywordDir, 'thread-900001-comments.json'),
  JSON.stringify(thread, null, 2),
  'utf8',
);

console.log(JSON.stringify({ level: 'info', message: 'fake search page 1' }));
console.log(JSON.stringify({ level: 'warning', message: 'fake warning' }));

if (mode === 'error') {
  console.error(JSON.stringify({ level: 'error', message: 'fake failure' }));
  process.exit(1);
}

console.log(JSON.stringify({ level: 'info', message: 'fake done', stopReason: 'completed' }));
