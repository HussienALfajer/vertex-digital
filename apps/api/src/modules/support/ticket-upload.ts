import { FilesInterceptor } from '@nestjs/platform-express';
import { TICKET_LIMITS } from '@vertex-digital/contracts';

/** Up to 3 images of at most 5 MB each (TK11); a larger one answers `413 PAYLOAD_TOO_LARGE`. */
export const ticketUpload = FilesInterceptor('files', TICKET_LIMITS.imagesPerMessage, {
  limits: {
    fileSize: TICKET_LIMITS.imageMaxBytes,
    files: TICKET_LIMITS.imagesPerMessage,
    fields: 8,
  },
});

/** The multipart body of a ticket or a message, for OpenAPI. */
export const ticketBody = (fields: Record<string, unknown>) => ({
  schema: {
    type: 'object',
    properties: {
      ...fields,
      files: { type: 'array', items: { type: 'string', format: 'binary' }, maxItems: 3 },
    },
  },
});

/** The images multer read, in their order. */
export type Uploads = { buffer: Buffer }[] | undefined;
