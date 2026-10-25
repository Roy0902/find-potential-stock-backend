export type RateLimitState = {
  attempts: number;
  windowStartedAt: number;
};

export class LoginRateLimiter {
  private readonly attempts = new Map<string, RateLimitState>();

  constructor(
    private readonly limit: number,
    private readonly windowMinutes: number,
  ) {}

  check(key: string): { allowed: boolean; retryAfterSeconds: number } {
    const now = Date.now();
    const state = this.attempts.get(key);
    if (!state) return { allowed: true, retryAfterSeconds: 0 };

    const windowMs = this.windowMinutes * 60_000;
    if (now - state.windowStartedAt > windowMs) {
      this.attempts.delete(key);
      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (state.attempts >= this.limit) {
      const retryAfter = Math.ceil((state.windowStartedAt + windowMs - now) / 1000);
      return { allowed: false, retryAfterSeconds: Math.max(retryAfter, 1) };
    }

    return { allowed: true, retryAfterSeconds: 0 };
  }

  recordFailure(key: string): void {
    const now = Date.now();
    const state = this.attempts.get(key);
    const windowMs = this.windowMinutes * 60_000;
    if (!state || now - state.windowStartedAt > windowMs) {
      this.attempts.set(key, { attempts: 1, windowStartedAt: now });
      return;
    }
    state.attempts += 1;
  }

  reset(key: string): void {
    this.attempts.delete(key);
  }
}
