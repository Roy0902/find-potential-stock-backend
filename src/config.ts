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
};

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: intFromEnv('PORT', 3000),
    host: env.HOST ?? '0.0.0.0',
    databaseUrl:
      env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/find_potential_stock',
    corsOrigins: (env.CORS_ORIGIN ?? 'http://localhost:5173')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    logLevel: env.LOG_LEVEL ?? 'info',
    nodeEnv: env.NODE_ENV ?? 'development',
    sessionTtlMinutes: intFromEnv('SESSION_TTL_MINUTES', 30),
    loginRateLimit: intFromEnv('LOGIN_RATE_LIMIT', 5),
    loginRateWindowMinutes: intFromEnv('LOGIN_RATE_WINDOW_MINUTES', 15),
    secureCookies: env.SECURE_COOKIES === 'true' || (env.NODE_ENV ?? 'development') === 'production',
  };
}
