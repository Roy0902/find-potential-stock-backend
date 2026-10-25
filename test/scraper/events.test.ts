import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEventLine } from '../../src/scraper/events.js';

describe('parseEventLine', () => {
  test('parses the scraper JSON protocol', () => {
    assert.deepEqual(parseEventLine('{"level":"info","message":"page 1"}'), {
      level: 'info',
      message: 'page 1',
      stopReason: undefined,
      data: undefined,
    });
    assert.deepEqual(parseEventLine('{"level":"warn","message":"careful"}'), {
      level: 'warning',
      message: 'careful',
      stopReason: undefined,
      data: undefined,
    });
    assert.deepEqual(parseEventLine('{"level":"error","message":"boom"}'), {
      level: 'error',
      message: 'boom',
      stopReason: undefined,
      data: undefined,
    });
  });

  test('keeps the stop reason and data from the summary event', () => {
    const event = parseEventLine(
      '{"level":"info","message":"done","stopReason":"completed","data":{"threadsProcessed":2}}',
    );
    assert.equal(event?.stopReason, 'completed');
    assert.deepEqual(event?.data, { threadsProcessed: 2 });
  });

  test('accepts the plain [Level] prefix', () => {
    assert.deepEqual(parseEventLine('[Warning] careful'), {
      level: 'warning',
      message: 'careful',
      stopReason: undefined,
      data: undefined,
    });
    assert.equal(parseEventLine('[Error] boom')?.level, 'error');
  });

  test('falls back to the stream for plain lines', () => {
    assert.equal(parseEventLine('plain stdout')?.level, 'info');
    assert.equal(parseEventLine('plain stderr', 'stderr')?.level, 'warning');
  });

  test('treats malformed JSON as a plain line', () => {
    assert.equal(parseEventLine('{"level":"info"', 'stdout')?.level, 'info');
  });

  test('ignores blank lines', () => {
    assert.equal(parseEventLine('   '), null);
  });
});
