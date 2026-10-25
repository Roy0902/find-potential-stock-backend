import { randomBytes } from 'node:crypto';
import type { Database } from '../db.js';

export const SESSION_COOKIE = 'fps_session';

export type SessionRecord = {
  token: string;
  ownerId: number;
  username: string;
};

export class SessionStore {
  constructor(
    private readonly db: Database,
    private readonly ttlMinutes: number,
  ) {}

  async create(ownerId: number, username: string): Promise<SessionRecord> {
    const token = randomBytes(32).toString('hex');
    const now = new Date();
    await this.db.query(
      `INSERT INTO owner_session (token, owner_id, created_at, last_seen_at)
       VALUES ($1, $2, $3, $3)`,
      [token, ownerId, now],
    );
    return { token, ownerId, username };
  }

  async resolve(token: string): Promise<SessionRecord | null> {
    const result = await this.db.query<{ owner_id: number; username: string; last_seen_at: Date }>(
      `SELECT s.owner_id, o.username, s.last_seen_at
         FROM owner_session s
         JOIN owner_account o ON o.id = s.owner_id
        WHERE s.token = $1`,
      [token],
    );
    const row = result.rows[0];
    if (!row) return null;

    const idleMs = Date.now() - new Date(row.last_seen_at).getTime();
    if (idleMs > this.ttlMinutes * 60_000) {
      await this.destroy(token);
      return null;
    }

    await this.db.query('UPDATE owner_session SET last_seen_at = now() WHERE token = $1', [token]);
    return { token, ownerId: row.owner_id, username: row.username };
  }

  async destroy(token: string): Promise<void> {
    await this.db.query('DELETE FROM owner_session WHERE token = $1', [token]);
  }

  async destroyExpired(): Promise<void> {
    await this.db.query(
      `DELETE FROM owner_session WHERE last_seen_at < now() - ($1 || ' minutes')::interval`,
      [String(this.ttlMinutes)],
    );
  }
}

export function cookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    secure,
  };
}

export function readSessionCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}
