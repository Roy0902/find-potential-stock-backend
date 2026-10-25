import type { FastifyReply } from 'fastify';
import type { ErrorResponse } from './types/response/error.response.js';

export type { ErrorResponse };

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
  }

  static badRequest(message: string, code = 'BAD_REQUEST') {
    return new HttpError(400, code, message);
  }

  static notFound(message: string, code = 'NOT_FOUND') {
    return new HttpError(404, code, message);
  }

  static unavailable(message: string, code = 'DATABASE_UNAVAILABLE') {
    return new HttpError(503, code, message);
  }
}

export function toErrorEnvelope(error: HttpError): ErrorResponse {
  return { code: error.statusCode, message: error.message, data: null };
}

export function sendError(reply: FastifyReply, error: HttpError) {
  return reply.status(error.statusCode).send(toErrorEnvelope(error));
}
