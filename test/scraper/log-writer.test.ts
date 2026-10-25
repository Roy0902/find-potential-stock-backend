import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogWriter } from '../../src/scraper/log-writer.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fps-log-'));
  dirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('LogWriter', () => {
  test('writes the requested format and counts errors', async () => {
    const dir = await tempDir();
    const writer = new LogWriter({
      dir,
      maxBytes: 1024,
      now: () => new Date('2026-10-25T03:00:00.000Z'),
    });
    await writer.init();

    await writer.write('info', 'started');
    await writer.write('warning', 'careful\nnext line');
    await writer.write('error', 'boom');

    assert.equal(writer.errorCount, 1);
    const text = await readFile(writer.path, 'utf8');
    assert.equal(
      text,
      [
        '[Info] 2026-10-25T03:00:00.000Z started',
        '[Warning] 2026-10-25T03:00:00.000Z careful | next line',
        '[Error] 2026-10-25T03:00:00.000Z boom',
        '',
      ].join('\n'),
    );
  });

  test('rotates to a new file when the size limit would be exceeded', async () => {
    const dir = await tempDir();
    const writer = new LogWriter({ dir, maxBytes: 120 });
    await writer.init();

    for (let index = 0; index < 8; index += 1) {
      await writer.write('info', `message ${index} with some padding`);
    }
    await writer.close();

    const names = (await readdir(dir)).filter((name) => /^log_\d+\.txt$/.test(name)).sort();
    assert.ok(names.length > 1, 'expected more than one rotated file');

    const contents = await Promise.all(names.map((name) => readFile(join(dir, name), 'utf8')));
    const all = contents.join('');
    for (let index = 0; index < 8; index += 1) {
      assert.match(all, new RegExp(`message ${index} with some padding`));
    }
    for (const [index, text] of contents.entries()) {
      const bytes = Buffer.byteLength(text, 'utf8');
      assert.ok(bytes <= 120 || text.split('\n').length === 2, `log_${index + 1} is ${bytes} bytes`);
    }
  });

  test('continues numbering across a restart', async () => {
    const dir = await tempDir();
    const first = new LogWriter({ dir, maxBytes: 60 });
    await first.init();
    await first.write('info', 'first message that fills the file');
    await first.write('info', 'second message that rotates');
    await first.close();
    const firstNumber = Number(/log_(\d+)\.txt$/.exec(first.path)?.[1] ?? 0);

    const second = new LogWriter({ dir, maxBytes: 60 });
    await second.init();
    await second.write('info', 'after restart');
    await second.close();
    const secondNumber = Number(/log_(\d+)\.txt$/.exec(second.path)?.[1] ?? 0);

    assert.ok(secondNumber >= firstNumber);
    assert.match(await readFile(second.path, 'utf8'), /after restart/);
  });
});
