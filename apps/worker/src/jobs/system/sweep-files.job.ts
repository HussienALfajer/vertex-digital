import type { Dirent } from 'node:fs';
import { readdir, stat, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { QUEUES, REVIEW_TIME_ZONE } from '@vertex-digital/contracts';
import { type Database, STORED_FILE_KINDS, storedFiles } from '@vertex-digital/db';
import { inArray, sql } from 'drizzle-orm';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';

export const SWEEP_FILES_CRON = '15 5 * * *';

/** Files marked swept per statement, and stored file ids looked up per query on disk. */
export const SWEEP_FILES_BATCH = 500;

/** A file on disk with no row this old is a refused upload: no row will ever take it. */
export const ORPHAN_FILE_DAYS = 30;

/** A derived width's temporary file this old was left by a process that died mid-write. */
const TEMPORARY_FILE_HOURS = 24;

const DAY_MS = 86_400_000;

/** `<id>.webp`, `<id>.png` and a catalog image's widths `<id>.w<width>.webp` (S09 SF5). */
const FILE_NAME =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.w\d+)?\.(?:webp|png)$/;
const TEMPORARY_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.w\d+)?\.webp\.[0-9a-f]{12}\.tmp$/;

type Found = { path: string; id: string };

/**
 * `system.sweep-files` (audit A10-45), daily at 05:15 Damascus. In the database,
 * `stored_files_mark_unreferenced` and `stored_files_sweep` (migration 0103) mark a catalog image,
 * QR image or logo that no row has referenced for 30 days as swept; the row stays as the record and
 * the API no longer serves it. On disk this job then removes the files of swept rows (with their
 * widths), files with no row at all after `ORPHAN_FILE_DAYS` (an upload whose transaction was
 * refused) and stale temporary files. Receipts, proofs, attachments and shop photos are always
 * referenced, so only a file with no row of theirs is ever removed. The worker writes under
 * `FILES_ROOT` only here. Safe to run twice: a missing file is not an error.
 */
@Injectable()
export class SweepFilesJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(SweepFilesJob.name);
  private readonly filesRoot: string;

  constructor(
    private readonly pgBoss: PgBossService,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) env: Env,
  ) {
    // A relative root is the API's: it runs in `apps/api`, the worker in `apps/worker`.
    this.filesRoot = isAbsolute(env.FILES_ROOT)
      ? env.FILES_ROOT
      : resolve('..', 'api', env.FILES_ROOT);
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work(QUEUES.systemSweepFiles, async () => {
      const { swept, removed } = await this.sweep();
      if (swept + removed > 0) {
        this.logger.log(`Swept ${swept} unused stored files and removed ${removed} files on disk`);
      }
    });
    await this.pgBoss.boss.schedule(QUEUES.systemSweepFiles, SWEEP_FILES_CRON, undefined, {
      tz: REVIEW_TIME_ZONE,
    });
    this.logger.log(`Scheduled ${QUEUES.systemSweepFiles} (${SWEEP_FILES_CRON} Damascus)`);
  }

  /** Marks and sweeps in the database, then clears the disk; rows swept and files removed. */
  async sweep(now = new Date()): Promise<{ swept: number; removed: number }> {
    await this.db.execute(sql`select stored_files_mark_unreferenced()`);
    let swept = 0;
    for (;;) {
      const { rows } = await this.db.execute<{ key: string }>(
        sql`select stored_files_sweep(${SWEEP_FILES_BATCH}) as key`,
      );
      swept += rows.length;
      if (rows.length < SWEEP_FILES_BATCH) break;
    }
    return { swept, removed: await this.clearDisk(now) };
  }

  /** Removes the files of swept rows, files with no row past `ORPHAN_FILE_DAYS`, stale temps. */
  private async clearDisk(now: Date): Promise<number> {
    let removed = 0;
    for (const kind of STORED_FILE_KINDS) {
      for (const folder of await this.entries(join(this.filesRoot, kind))) {
        if (!folder.isDirectory() || !/^[0-9a-f]{2}$/.test(folder.name)) continue;
        const directory = join(this.filesRoot, kind, folder.name);
        const found: Found[] = [];
        for (const entry of await this.entries(directory)) {
          if (!entry.isFile()) continue;
          const path = join(directory, entry.name);
          if (TEMPORARY_NAME.test(entry.name)) {
            if (await this.olderThan(path, now, TEMPORARY_FILE_HOURS * 3_600_000)) {
              removed += await this.remove(path);
            }
            continue;
          }
          const id = FILE_NAME.exec(entry.name)?.[1];
          if (id) found.push({ path, id });
        }
        for (let start = 0; start < found.length; start += SWEEP_FILES_BATCH) {
          removed += await this.clearBatch(found.slice(start, start + SWEEP_FILES_BATCH), now);
        }
      }
    }
    return removed;
  }

  private async clearBatch(batch: readonly Found[], now: Date): Promise<number> {
    const rows = await this.db
      .select({ id: storedFiles.id, sweptAt: storedFiles.sweptAt })
      .from(storedFiles)
      .where(inArray(storedFiles.id, [...new Set(batch.map((file) => file.id))]));
    const known = new Map(rows.map((row) => [row.id, row.sweptAt !== null]));
    let removed = 0;
    for (const file of batch) {
      const swept = known.get(file.id);
      if (swept === false) continue;
      if (
        swept === undefined &&
        !(await this.olderThan(file.path, now, ORPHAN_FILE_DAYS * DAY_MS))
      ) {
        continue;
      }
      removed += await this.remove(file.path);
    }
    return removed;
  }

  private async entries(directory: string): Promise<Dirent[]> {
    try {
      return await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async olderThan(path: string, now: Date, ageMs: number): Promise<boolean> {
    try {
      return now.getTime() - (await stat(path)).mtimeMs > ageMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  /** 1 when the file was removed, 0 when it was already gone. */
  private async remove(path: string): Promise<number> {
    try {
      await unlink(path);
      return 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
  }
}
