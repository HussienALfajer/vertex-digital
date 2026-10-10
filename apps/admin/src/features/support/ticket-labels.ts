import { TICKET_LIMITS, type TicketStatus } from '@vertex-digital/contracts';

/** The status chip of a ticket (TK3): waiting for the admin stands out. */
export const TICKET_STATUS_TONES = {
  open: 'gold',
  answered: 'info',
  closed: 'neutral',
} as const satisfies Record<TicketStatus, string>;

/** What the API accepts per image (TK11); the API re-encodes and checks again. */
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export type ImageRefusal = 'tooMany' | 'tooLarge' | 'badType';

/**
 * The images picked for a message, added to those already there: at most 3 (TK11), each a JPEG,
 * PNG or WebP of at most 5 MB. The refused files are reported with the reason, the rest kept.
 */
export function addImages(
  current: File[],
  picked: File[],
): { files: File[]; refused: { name: string; reason: ImageRefusal }[] } {
  const files = [...current];
  const refused: { name: string; reason: ImageRefusal }[] = [];
  for (const file of picked) {
    if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) {
      refused.push({ name: file.name, reason: 'badType' });
    } else if (file.size > TICKET_LIMITS.imageMaxBytes) {
      refused.push({ name: file.name, reason: 'tooLarge' });
    } else if (files.length >= TICKET_LIMITS.imagesPerMessage) {
      refused.push({ name: file.name, reason: 'tooMany' });
    } else {
      files.push(file);
    }
  }
  return { files, refused };
}
