import nodemailer from 'nodemailer';
import type { SmtpConfig } from '../config.js';
import type { ScrapeRunMode, ScrapeRunStatus } from '../types/data/scrape.data.js';

export type MailMessage = {
  from: string;
  to: string;
  subject: string;
  text: string;
};

export type MailTransport = {
  sendMail(message: MailMessage): Promise<unknown>;
};

export type TransportFactory = (config: SmtpConfig) => MailTransport;

export type ErrorReport = {
  id: number | null;
  mode: ScrapeRunMode;
  status: Exclude<ScrapeRunStatus, 'running'>;
  startedAt: Date;
  finishedAt: Date;
  stopReason: string;
  logFile: string | null;
  commentsAdded: number;
  commentsSkippedRestricted: number;
  errors: string[];
};

export type NotifyResult = {
  sent: boolean;
  error?: string;
};

function defaultFactory(config: SmtpConfig): MailTransport {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.pass } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
  });
}

/** Sends at most one summary email per scrape run, and only when the run logged an error. */
export class ErrorNotifier {
  private readonly transport: MailTransport | null;

  constructor(
    private readonly config: SmtpConfig,
    factory: TransportFactory = defaultFactory,
  ) {
    this.transport = config.host ? factory(config) : null;
  }

  get configured(): boolean {
    return this.transport !== null;
  }

  async send(report: ErrorReport): Promise<NotifyResult> {
    if (!this.transport) {
      return { sent: false, error: 'SMTP is not configured' };
    }

    const count = report.errors.length;
    const label = report.id ?? 'startup';
    const subject = `[find-potential-stock] Scrape run ${label} ${report.status} (${count} error${count === 1 ? '' : 's'})`;
    const shown = report.errors.slice(0, 50);
    const lines = [
      `Scrape run ${label} finished with status ${report.status}.`,
      '',
      `Mode: ${report.mode}`,
      `Started: ${report.startedAt.toISOString()}`,
      `Finished: ${report.finishedAt.toISOString()}`,
      `Stop reason: ${report.stopReason}`,
      `Comments added: ${report.commentsAdded}`,
      `Comments skipped (restricted): ${report.commentsSkippedRestricted}`,
      `Log file: ${report.logFile ?? '(not written)'}`,
      '',
      `Errors (${count}):`,
      ...shown.map((error) => `- ${error}`),
    ];
    if (count > shown.length) {
      lines.push(`- ... ${count - shown.length} more in the log file`);
    }

    try {
      await this.transport.sendMail({
        from: this.config.from,
        to: this.config.to,
        subject,
        text: lines.join('\n'),
      });
      return { sent: true };
    } catch (error) {
      return { sent: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
