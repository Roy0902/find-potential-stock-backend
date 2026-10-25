import { appendFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ScrapeLogLevel } from '../types/data/scrape.data.js';

const LABELS: Record<ScrapeLogLevel, string> = {
  info: 'Info',
  warning: 'Warning',
  error: 'Error',
};

const FILE_PATTERN = /^log_(\d+)\.txt$/;

export type LogWriterOptions = {
  dir: string;
  maxBytes: number;
  now?: () => Date;
};

/**
 * Append-only rotating text log. Files are `log_1.txt`, `log_2.txt`, ... and a new number
 * starts when the current file would grow past `maxBytes`. Numbering continues across
 * process restarts by scanning the directory.
 */
export class LogWriter {
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly now: () => Date;
  private number = 1;
  private size = 0;
  private currentPath = '';
  private firstPathValue = '';
  private errors = 0;
  private ready = false;

  constructor(options: LogWriterOptions) {
    this.dir = options.dir;
    this.maxBytes = Math.max(1, options.maxBytes);
    this.now = options.now ?? (() => new Date());
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    this.number = await this.latestNumber();
    this.currentPath = this.pathFor(this.number);
    this.firstPathValue = this.currentPath;
    this.size = await this.sizeOf(this.currentPath);
    // Rotation happens on the first write, not here: a run that is skipped before it owns
    // a scrape_run row must not rotate the active run's log.
    this.ready = true;
  }

  async write(level: ScrapeLogLevel, message: string): Promise<void> {
    if (!this.ready) throw new Error('LogWriter.init() must be called before write()');
    const line = this.format(level, message);
    const bytes = Buffer.byteLength(line, 'utf8');
    if (this.size > 0 && this.size + bytes > this.maxBytes) {
      await this.rotate();
    }
    await appendFile(this.currentPath, line, 'utf8');
    this.size += bytes;
    if (level === 'error') this.errors += 1;
  }

  get path(): string {
    return this.currentPath;
  }

  /** The first file this writer used; a rotated run keeps its opening events here. */
  get firstPath(): string {
    return this.firstPathValue || this.currentPath;
  }

  get errorCount(): number {
    return this.errors;
  }

  async close(): Promise<void> {
    this.ready = false;
  }

  private format(level: ScrapeLogLevel, message: string): string {
    const safe = message
      .replace(/[\r\n]+/g, ' | ')
      .trim()
      .slice(0, 8192);
    return `[${LABELS[level]}] ${this.now().toISOString()} ${safe}\n`;
  }

  private pathFor(number: number): string {
    return join(this.dir, `log_${number}.txt`);
  }

  private async rotate(): Promise<void> {
    this.number += 1;
    this.currentPath = this.pathFor(this.number);
    this.size = 0;
  }

  private async latestNumber(): Promise<number> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    let highest = 0;
    for (const name of names) {
      const match = FILE_PATTERN.exec(name);
      if (match) highest = Math.max(highest, Number(match[1]));
    }
    return highest || 1;
  }

  private async sizeOf(path: string): Promise<number> {
    try {
      return (await stat(path)).size;
    } catch {
      return 0;
    }
  }
}
