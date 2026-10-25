import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';
import { HttpError } from '../http-error.js';
import { hashPassword, verifyPassword } from './password.js';
import { LoginRateLimiter } from './rate-limit.js';
import { SESSION_COOKIE, readSessionCookie, type SessionStore } from './session.js';
import type { LoginBody } from '../types/request/admin.request.js';
import { success } from '../http-response.js';

// Compared against when the username does not exist, so both failure paths cost one scrypt run.
const DUMMY_HASH = hashPassword('not-a-real-password');

export async function authRoutes(
  app: FastifyInstance,
  options: {
    db: Database;
    sessions: SessionStore;
    limiter: LoginRateLimiter;
    config: AppConfig;
  },
) {
  const { db, sessions, limiter, config } = options;

  app.post<{ Body: LoginBody }>(
    '/api/admin/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          additionalProperties: false,
          properties: {
            username: { type: 'string', minLength: 1, maxLength: 200 },
            password: { type: 'string', minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      const key = request.ip;
      const status = limiter.check(key);
      if (!status.allowed) {
        reply.header('retry-after', String(status.retryAfterSeconds));
        throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many attempts. Try again later.');
      }

      const result = await db.query<{ id: number; username: string; password_hash: string }>(
        'SELECT id, username, password_hash FROM owner_account WHERE username = $1',
        [request.body.username],
      );
      const owner = result.rows[0];
      const passwordMatches = verifyPassword(
        request.body.password ?? '',
        owner?.password_hash ?? DUMMY_HASH,
      );

      if (!owner || !passwordMatches) {
        limiter.recordFailure(key);
        throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid username or password.');
      }

      limiter.reset(key);
      const session = await sessions.create(owner.id, owner.username);
      const cookie = [
        `${SESSION_COOKIE}=${session.token}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${config.sessionTtlMinutes * 60}`,
      ];
      if (config.secureCookies) cookie.push('Secure');
      reply.header('set-cookie', cookie.join('; '));
      return success({ ok: true });
    },
  );

  app.post('/api/admin/logout', async (request, reply) => {
    const token = readSessionCookie(request.headers.cookie);
    const session = token ? await sessions.resolve(token) : null;
    if (!session) {
      throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in required.');
    }
    await sessions.destroy(session.token);
    reply.header('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return reply.status(204).send();
  });
}
