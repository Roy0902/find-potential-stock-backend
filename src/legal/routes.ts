import type { FastifyInstance } from 'fastify';
import { success } from '../http-response.js';
import { DISCLAIMER } from '../legal.js';

export async function legalRoutes(app: FastifyInstance) {
  app.get('/api/disclaimer', async () => success({ disclaimer: DISCLAIMER }));
}
