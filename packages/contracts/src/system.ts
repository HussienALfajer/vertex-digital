import { z } from 'zod';

/** `GET /api/health`: the API and its dependencies, for nginx, PM2 and the deploy checks. */
export const healthResponseSchema = z
  .object({
    status: z.enum(['ok', 'error']),
    checks: z.object({ database: z.enum(['up', 'down']) }),
    timestamp: z.iso.datetime(),
  })
  .meta({ id: 'HealthResponse' });

export type HealthResponse = z.infer<typeof healthResponseSchema>;
