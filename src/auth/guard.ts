import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError, sendError } from '../http/http-error.js';
import { readSessionCookie, type SessionRecord, type SessionStore } from './session.js';

declare module 'fastify' {
  interface FastifyRequest {
    owner?: SessionRecord;
  }
}

export function makeGuard(sessions: SessionStore) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const token = readSessionCookie(request.headers.cookie);
    if (!token) {
      await sendError(reply, new HttpError(401, 'UNAUTHENTICATED', 'Sign in required.'));
      return reply;
    }
    const session = await sessions.resolve(token);
    if (!session) {
      await sendError(reply, new HttpError(401, 'UNAUTHENTICATED', 'Sign in required.'));
      return reply;
    }
    request.owner = session;
  };
}
