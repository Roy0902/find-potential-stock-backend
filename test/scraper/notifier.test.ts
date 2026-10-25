import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorNotifier, type MailMessage, type MailTransport } from '../../src/scraper/notifier.js';
import type { SmtpConfig } from '../../src/config.js';
import type { ErrorReport } from '../../src/scraper/notifier.js';

function smtp(overrides: Partial<SmtpConfig> = {}): SmtpConfig {
  return {
    host: 'smtp.test',
    port: 587,
    secure: false,
    user: 'user',
    pass: 'pass',
    from: 'alerts@test.local',
    to: 'roy2b32@gmail.com',
    ...overrides,
  };
}

function report(errors: string[]): ErrorReport {
  return {
    id: 7,
    mode: 'incremental',
    status: 'failed',
    startedAt: new Date('2026-10-25T03:00:00.000Z'),
    finishedAt: new Date('2026-10-25T03:01:00.000Z'),
    stopReason: 'error',
    logFile: 'logs/scraper/log_1.txt',
    commentsAdded: 3,
    commentsSkippedRestricted: 1,
    errors,
  };
}

describe('ErrorNotifier', () => {
  test('sends one summary email with the error lines', async () => {
    const sent: MailMessage[] = [];
    const factory = (): MailTransport => ({
      sendMail: async (message) => {
        sent.push(message);
      },
    });
    const notifier = new ErrorNotifier(smtp(), factory);

    const result = await notifier.send(report(['thread 1 timed out', 'thread 2 failed']));

    assert.deepEqual(result, { sent: true });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to, 'roy2b32@gmail.com');
    assert.equal(sent[0]!.from, 'alerts@test.local');
    assert.match(sent[0]!.subject, /run 7 failed \(2 errors\)/);
    assert.match(sent[0]!.text, /- thread 1 timed out/);
    assert.match(sent[0]!.text, /- thread 2 failed/);
    assert.match(sent[0]!.text, /logs\/scraper\/log_1\.txt/);
  });

  test('is not configured without an SMTP host', async () => {
    const notifier = new ErrorNotifier(smtp({ host: '' }), () => {
      throw new Error('transport should not be created');
    });
    assert.equal(notifier.configured, false);
    const result = await notifier.send(report(['boom']));
    assert.equal(result.sent, false);
    assert.match(result.error ?? '', /SMTP is not configured/);
  });

  test('reports a transport failure without throwing', async () => {
    const notifier = new ErrorNotifier(smtp(), () => ({
      sendMail: async () => {
        throw new Error('connection refused');
      },
    }));
    const result = await notifier.send(report(['boom']));
    assert.equal(result.sent, false);
    assert.match(result.error ?? '', /connection refused/);
  });

  test('truncates a long error list and points at the log', async () => {
    const sent: MailMessage[] = [];
    const notifier = new ErrorNotifier(smtp(), () => ({
      sendMail: async (message) => {
        sent.push(message);
      },
    }));
    const errors = Array.from({ length: 55 }, (_, index) => `error ${index}`);
    await notifier.send(report(errors));
    assert.match(sent[0]!.text, /- error 49/);
    assert.doesNotMatch(sent[0]!.text, /- error 50/);
    assert.match(sent[0]!.text, /\.\.\. 5 more in the log file/);
  });
});
