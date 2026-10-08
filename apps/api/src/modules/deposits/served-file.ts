import { StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import type { ServedFile } from '../files/index.js';

/**
 * Sends a stored image: through nginx (`X-Accel-Redirect`) in production, else the bytes. Never
 * sniffed into another type, shown inline, cached as the route says (rule SC15).
 */
export async function sendImage(
  response: Response,
  file: ServedFile,
  cacheControl: string,
): Promise<StreamableFile | undefined> {
  response.setHeader('cache-control', cacheControl);
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('content-disposition', 'inline');
  response.setHeader('content-type', file.contentType);
  if (file.accelPath) {
    response.setHeader('x-accel-redirect', file.accelPath);
    return undefined;
  }
  return new StreamableFile(await file.read(), { type: file.contentType });
}

/** The multipart body of an upload route, for OpenAPI. */
export const uploadBody = (extra: Record<string, unknown> = {}) => ({
  schema: {
    type: 'object',
    required: ['file'],
    properties: { file: { type: 'string', format: 'binary' }, ...extra },
  },
});
