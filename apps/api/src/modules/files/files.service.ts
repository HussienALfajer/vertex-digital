import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  CATALOG_IMAGE_MAX_DIMENSION,
  CATALOG_IMAGE_MAX_INPUT_PIXELS,
  DHASH_HEIGHT,
  DHASH_WIDTH,
  dHash,
  QR_MAX_DIMENSION,
  RECEIPT_MAX_DIMENSION,
  UPLOAD_MAX_INPUT_PIXELS,
} from '@vertex-digital/contracts';
import { type Database, newId, storedFiles, type Transaction } from '@vertex-digital/db';
import { and, eq, inArray } from 'drizzle-orm';
import sharp, { type OutputInfo } from 'sharp';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import { FileStorage } from './file-storage.js';

type StoredFileRow = typeof storedFiles.$inferInsert;
type StoredFileKind = StoredFileRow['kind'];

/** A re-encoded image written to disk, whose row the caller inserts in its transaction. */
export interface PreparedImage {
  row: Required<Pick<StoredFileRow, 'id' | 'kind' | 'storageKey' | 'contentType'>> &
    Pick<StoredFileRow, 'byteSize' | 'width' | 'height'>;
  /** SHA-256 of the uploaded bytes (rule FL1). */
  originalSha256: Buffer;
  /** The dHash of the decoded image (rule FL2). */
  perceptualHash: bigint;
}

/** A stored file as a route sends it. */
export interface ServedFile {
  contentType: string;
  /** The nginx internal path (production), else null. */
  accelPath: string | null;
  read: () => Promise<Buffer>;
}

/**
 * What each kind becomes: receipts WebP up to 2000 px, QR images PNG up to 1000 px, catalog images
 * WebP up to 1600 px from at most 25 megapixels (S06 rule CT10), delivery proofs as receipts
 * (S11); and the code that refuses it.
 */
const OUTPUT = {
  deposit_receipt: {
    format: 'webp',
    contentType: 'image/webp',
    maxDimension: RECEIPT_MAX_DIMENSION,
    maxInputPixels: UPLOAD_MAX_INPUT_PIXELS,
    invalidCode: 'RECEIPT_INVALID',
  },
  sham_cash_qr: {
    format: 'png',
    contentType: 'image/png',
    maxDimension: QR_MAX_DIMENSION,
    maxInputPixels: UPLOAD_MAX_INPUT_PIXELS,
    invalidCode: 'RECEIPT_INVALID',
  },
  catalog_image: {
    format: 'webp',
    contentType: 'image/webp',
    maxDimension: CATALOG_IMAGE_MAX_DIMENSION,
    maxInputPixels: CATALOG_IMAGE_MAX_INPUT_PIXELS,
    invalidCode: 'IMAGE_INVALID',
  },
  /** S11 rule MF2: a manual delivery's screenshot, re-encoded like a receipt. */
  delivery_proof: {
    format: 'webp',
    contentType: 'image/webp',
    maxDimension: RECEIPT_MAX_DIMENSION,
    maxInputPixels: UPLOAD_MAX_INPUT_PIXELS,
    invalidCode: 'IMAGE_INVALID',
  },
} as const satisfies Record<StoredFileKind, unknown>;

/** Formats accepted by their content, whatever the file name or declared type says (rule SC8). */
const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp']);

const invalid = (kind: StoredFileKind) =>
  new CodedException(400, OUTPUT[kind].invalidCode, 'The upload is not a JPEG, PNG or WebP image');

/**
 * Uploaded images (S03 rule SC8): decoded with a pixel limit, rotated upright, stripped of their
 * metadata, resized and re-encoded, so no uploaded byte is ever served. The only writer of
 * `stored_files`. The file is written before the caller's transaction and its row inside it: a
 * rolled-back request leaves an orphan file that nothing references.
 */
@Injectable()
export class FilesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly storage: FileStorage,
  ) {}

  /**
   * Re-encodes and writes an upload; `RECEIPT_INVALID` (`IMAGE_INVALID` for catalog images) when
   * it is not an accepted image.
   */
  async prepare(kind: StoredFileKind, upload: Buffer | undefined): Promise<PreparedImage> {
    if (!upload || upload.length === 0) throw invalid(kind);
    const output = OUTPUT[kind];
    const decode = () =>
      sharp(upload, { limitInputPixels: output.maxInputPixels, failOn: 'error' }).rotate();
    let encoded: { data: Buffer; info: OutputInfo };
    let pixels: { data: Buffer; info: OutputInfo };
    try {
      const { format } = await sharp(upload).metadata();
      if (!format || !ACCEPTED_FORMATS.has(format)) throw invalid(kind);
      const resized = decode().resize({
        width: output.maxDimension,
        height: output.maxDimension,
        fit: 'inside',
        withoutEnlargement: true,
      });
      encoded = await (output.format === 'webp'
        ? resized.webp({ quality: 85 })
        : resized.png()
      ).toBuffer({ resolveWithObject: true });
      pixels = await decode()
        .greyscale()
        .resize(DHASH_WIDTH, DHASH_HEIGHT, { fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true });
    } catch (error) {
      if (error instanceof CodedException) throw error;
      // Not an image, truncated, or above the pixel limit (a decompression bomb).
      throw invalid(kind);
    }
    const id = newId();
    const storageKey = `${kind}/${id.slice(-2)}/${id}.${output.format}`;
    await this.storage.put(storageKey, encoded.data);
    const channels = pixels.info.channels;
    const grey = Uint8Array.from({ length: DHASH_WIDTH * DHASH_HEIGHT }, (_, index) => {
      return pixels.data[index * channels] as number;
    });
    return {
      row: {
        id,
        kind,
        storageKey,
        contentType: output.contentType,
        byteSize: encoded.data.length,
        width: encoded.info.width,
        height: encoded.info.height,
      },
      originalSha256: createHash('sha256').update(upload).digest(),
      perceptualHash: dHash(grey),
    };
  }

  /** Inserts the prepared file's row in the caller's transaction. */
  async record(tx: Transaction, prepared: PreparedImage): Promise<string> {
    await tx.insert(storedFiles).values(prepared.row);
    return prepared.row.id;
  }

  /** Prepares and records a file on its own. */
  async store(kind: StoredFileKind, upload: Buffer | undefined): Promise<string> {
    const prepared = await this.prepare(kind, upload);
    return this.db.transaction((tx) => this.record(tx, prepared));
  }

  /** A stored file of `kind`, or null. */
  async serve(fileId: string, kind: StoredFileKind): Promise<ServedFile | null> {
    const [row] = await this.db
      .select({ storageKey: storedFiles.storageKey, contentType: storedFiles.contentType })
      .from(storedFiles)
      .where(and(eq(storedFiles.id, fileId), eq(storedFiles.kind, kind)));
    if (!row) return null;
    return {
      contentType: row.contentType,
      accelPath: this.storage.accelPath(row.storageKey),
      read: () => this.storage.read(row.storageKey),
    };
  }

  /**
   * A catalog image fitted to `width` (S09 rule SF5), as WebP, never upscaled: made once from the
   * stored image with the same decoder limit, kept beside it, then served like it. Null when the
   * file is not a catalog image.
   */
  async catalogVariant(fileId: string, width: number): Promise<ServedFile | null> {
    const [row] = await this.db
      .select({ storageKey: storedFiles.storageKey, width: storedFiles.width })
      .from(storedFiles)
      .where(and(eq(storedFiles.id, fileId), eq(storedFiles.kind, 'catalog_image')));
    if (!row) return null;
    if (row.width !== null && row.width <= width) return this.serve(fileId, 'catalog_image');
    const key = row.storageKey.replace(/\.webp$/, `.w${width}.webp`);
    if (!(await this.storage.exists(key))) {
      const resized = await sharp(await this.storage.read(row.storageKey), {
        limitInputPixels: CATALOG_IMAGE_MAX_INPUT_PIXELS,
        failOn: 'error',
      })
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer();
      await this.storage.putOnce(key, resized);
    }
    return {
      contentType: 'image/webp',
      accelPath: this.storage.accelPath(key),
      read: () => this.storage.read(key),
    };
  }

  /** The size of each of `fileIds` that is a stored file of `kind`. */
  async dimensions(
    fileIds: readonly string[],
    kind: StoredFileKind,
  ): Promise<Map<string, { width: number; height: number }>> {
    if (fileIds.length === 0) return new Map();
    const rows = await this.db
      .select({ id: storedFiles.id, width: storedFiles.width, height: storedFiles.height })
      .from(storedFiles)
      .where(and(inArray(storedFiles.id, [...fileIds]), eq(storedFiles.kind, kind)));
    return new Map(rows.map(({ id, ...size }) => [id, size]));
  }

  /** Which of `fileIds` are stored files of `kind`. */
  async existing(fileIds: readonly string[], kind: StoredFileKind): Promise<Set<string>> {
    const found = await Promise.all(fileIds.map((id) => this.serve(id, kind)));
    return new Set(fileIds.filter((_, index) => found[index] !== null));
  }
}
