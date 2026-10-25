export type ScrapeConfig = {
  enabled: boolean;
  cron: string;
  timezone: string;
  runOnStart: boolean;
  staleMinutes: number;
  source: string;
  keywords: string[];
  limit: number;
  sort: string;
  delayMs: number;
  timeoutMinutes: number;
  includeOp: boolean;
  outputDir: string;
  logDir: string;
  logMaxBytes: number;
};

export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  to: string;
};

export type AppConfig = {
  port: number;
  host: string;
  databaseUrl: string;
  corsOrigins: string[];
  logLevel: string;
  nodeEnv: string;
  sessionTtlMinutes: number;
  loginRateLimit: number;
  loginRateWindowMinutes: number;
  secureCookies: boolean;
  scrape: ScrapeConfig;
  smtp: SmtpConfig;
};

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

function boolFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

function listFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: string[]): string[] {
  const raw = env[name];
  if (!raw) return fallback;
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length ? values : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const config: AppConfig = {
    port: intFromEnv(env, 'PORT', 3000),
    host: env.HOST ?? '0.0.0.0',
    databaseUrl:
      env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/find_potential_stock',
    corsOrigins: (env.CORS_ORIGIN ?? 'http://localhost:5173')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    logLevel: env.LOG_LEVEL ?? 'info',
    nodeEnv: env.NODE_ENV ?? 'development',
    sessionTtlMinutes: intFromEnv(env, 'SESSION_TTL_MINUTES', 30),
    loginRateLimit: intFromEnv(env, 'LOGIN_RATE_LIMIT', 5),
    loginRateWindowMinutes: intFromEnv(env, 'LOGIN_RATE_WINDOW_MINUTES', 15),
    secureCookies: env.SECURE_COOKIES === 'true' || (env.NODE_ENV ?? 'development') === 'production',
    scrape: {
      enabled: boolFromEnv(env, 'SCRAPE_ENABLED', false),
      cron: env.SCRAPE_CRON ?? '0 3 * * *',
      timezone: env.SCRAPE_TIMEZONE ?? 'Asia/Hong_Kong',
      runOnStart: boolFromEnv(env, 'SCRAPE_RUN_ON_START', false),
      staleMinutes: intFromEnv(env, 'SCRAPE_STALE_MINUTES', 240),
      source: env.SCRAPE_SOURCE ?? 'LIHKG',
      keywords: listFromEnv(env, 'SCRAPE_KEYWORDS', ['劇']),
      limit: intFromEnv(env, 'SCRAPE_LIMIT', 10),
      sort: env.SCRAPE_SORT ?? 'desc_create_time',
      delayMs: intFromEnv(env, 'SCRAPE_DELAY_MS', 4000),
      timeoutMinutes: intFromEnv(env, 'SCRAPE_TIMEOUT_MINUTES', 180),
      includeOp: boolFromEnv(env, 'SCRAPE_INCLUDE_OP', false),
      outputDir: env.SCRAPE_OUTPUT_DIR ?? 'scrape-output',
      logDir: env.SCRAPE_LOG_DIR ?? 'logs/scraper',
      logMaxBytes: intFromEnv(env, 'SCRAPE_LOG_MAX_BYTES', 10 * 1024 * 1024),
    },
    smtp: {
      host: env.SMTP_HOST ?? '',
      port: intFromEnv(env, 'SMTP_PORT', 587),
      secure: boolFromEnv(env, 'SMTP_SECURE', false),
      user: env.SMTP_USER ?? '',
      pass: env.SMTP_PASS ?? '',
      from: env.ALERT_EMAIL_FROM ?? env.SMTP_USER ?? 'no-reply@find-potential-stock.local',
      to: env.ALERT_EMAIL_TO ?? 'roy2b32@gmail.com',
    },
  };

  if (config.scrape.staleMinutes <= config.scrape.timeoutMinutes + 5) {
    throw new Error(
      'SCRAPE_STALE_MINUTES must be greater than SCRAPE_TIMEOUT_MINUTES + 5, ' +
        'otherwise a live run can be treated as stale while it is still ingesting',
    );
  }

  return config;
}
