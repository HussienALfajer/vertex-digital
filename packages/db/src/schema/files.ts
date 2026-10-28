import { sql } from 'drizzle-orm';
import { check, integer, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { id } from './columns.js';

/*
 * Stored files (S03), owned by the api `files` module: the re-encoded images under `FILES_ROOT`,
 * outside the web root. A row is never deleted and its file never changed (receipts are evidence).
 * Append-only (migration 0012), except the sweep's two columns (audit A10-45, migration 0103): a
 * catalog image, QR image or logo nothing references for `STORED_FILE_SWEEP_DAYS` loses its file.
 */

/**
 * `catalog_image` (S06 rule CT10): game covers and ID guides, WebP within 1600 px.
 * `delivery_proof` (S11 rule MF2): a manual delivery's screenshot, re-encoded like a receipt.
 * `ticket_attachment` (S12 TK11): an image of a support message, re-encoded like a receipt.
 * `merchant_shop_photo` (S20 MA3): a merchant application's shop photo, re-encoded like a receipt.
 * `merchant_logo` (S21 BR3): a merchant's receipt logo, a square WebP of at most 512 px.
 */
export const STORED_FILE_KINDS = [
  'deposit_receipt',
  'sham_cash_qr',
  'catalog_image',
  'delivery_proof',
  'ticket_attachment',
  'merchant_shop_photo',
  'merchant_logo',
] as const;

export const storedFileKindEnum = pgEnum('stored_file_kind', STORED_FILE_KINDS);

export const storedFiles = pgTable(
  'stored_files',
  {
    id: id(),
    kind: storedFileKindEnum('kind').notNull(),
    /** A random path under the files root, never derived from user input. */
    storageKey: text('storage_key').notNull().unique(),
    /** `image/webp` for receipts, `image/png` for QR images. */
    contentType: text('content_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Audit A10-45: when the sweep first found nothing referencing this file (catalog images, QR
     * images and logos only); cleared when a row references it again. Set by
     * `stored_files_mark_unreferenced()` only (migration 0103).
     */
    unreferencedSince: timestamp('unreferenced_since', { withTimezone: true }),
    /** Audit A10-45: when the sweep removed the file from disk; final, and never served again. */
    sweptAt: timestamp('swept_at', { withTimezone: true }),
  },
  (table) => [
    check(
      'stored_files_storage_key_check',
      sql`${table.storageKey} ~ '^[a-z_]+/[0-9a-f]{2}/[0-9a-f-]{36}\\.(webp|png)$'`,
    ),
    check(
      'stored_files_content_type_check',
      sql`${table.contentType} in ('image/webp', 'image/png')`,
    ),
    check(
      'stored_files_size_check',
      sql`${table.byteSize} > 0 and ${table.width} > 0 and ${table.height} > 0`,
    ),
  ],
);
