import type { ScrapeLogLevel } from '../types/data/scrape.data.js';

export type ScrapeEvent = {
  level: ScrapeLogLevel;
  message: string;
  stopReason?: string;
  data?: Record<string, unknown>;
};

const LEVELS: Record<string, ScrapeLogLevel> = {
  info: 'info',
  warn: 'warning',
  warning: 'warning',
  error: 'error',
};

/**
 * The scraper emits one JSON object per line (`--json-logs`). Plain lines are accepted
 * too so an older script or an unexpected browser message still lands in the log.
 */
export function parseEventLine(
  line: string,
  stream: 'stdout' | 'stderr' = 'stdout',
): ScrapeEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof parsed.message === 'string') {
        const level =
          LEVELS[String(parsed.level ?? '').toLowerCase()] ??
          (stream === 'stderr' ? 'warning' : 'info');
        const data =
          parsed.data && typeof parsed.data === 'object'
            ? (parsed.data as Record<string, unknown>)
            : undefined;
        return {
          level,
          message: parsed.message,
          stopReason: typeof parsed.stopReason === 'string' ? parsed.stopReason : undefined,
          data,
        };
      }
    } catch {
      // Not JSON; fall through to the plain-line handling.
    }
  }

  const prefixed = /^\[(info|warning|warn|error)\]\s*(.*)$/i.exec(trimmed);
  if (prefixed) {
    const label = (prefixed[1] ?? '').toLowerCase();
    return {
      level: LEVELS[label] ?? (stream === 'stderr' ? 'warning' : 'info'),
      message: prefixed[2] ?? '',
      stopReason: undefined,
      data: undefined,
    };
  }

  return {
    level: stream === 'stderr' ? 'warning' : 'info',
    message: trimmed,
    stopReason: undefined,
    data: undefined,
  };
}
