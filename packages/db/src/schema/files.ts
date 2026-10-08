import { sql } from 'drizzle-orm';
import { check, integer, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { id } from './columns.js';

/*
 * Stored files (S03), owned by the api `files` module: the re-encoded images under `FILES_ROOT`,
 * outside the web root. A row and its file are never changed or deleted (receipts are evidence).
 * Append-only (migration 0012).
 */

/** `catalog_image` (S06 rule CT10): game covers and ID guides, WebP within 1600 px. */
export const STORED_FILE_KINDS = ['deposit_receipt', 'sham_cash_qr', 'catalog_image'] as const;

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
