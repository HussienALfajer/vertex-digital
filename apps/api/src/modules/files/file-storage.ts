import { randomBytes } from 'node:crypto';
import { access, link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path, { dirname, type PlatformPath, resolve } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../../core/config/env.js';

/**
 * Files on the local disk under `FILES_ROOT`, outside the web root (S03, ADR 0009). A key is a
 * random relative path the files service makes, never user input. A file is written once and
 * never replaced. In production nginx sends files through `X-Accel-Redirect`.
 */
@Injectable()
export class FileStorage {
  private readonly root: string;
  private readonly accelPrefix: string | undefined;

  constructor(@Inject(ENV) env: Env) {
    this.root = resolve(env.FILES_ROOT);
    this.accelPrefix = env.FILES_ACCEL_PREFIX;
  }

  /** Writes a new file; refuses to replace one (`wx`). Readable by its owner and group only. */
  async put(key: string, bytes: Buffer): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o750 });
    await writeFile(path, bytes, { flag: 'wx', mode: 0o640 });
  }

  /**
   * Writes a derived file (an image width, S09) unless another request wrote it first. Written
   * whole under a temporary name, then linked into place: the final path never holds part of a
   * file, even when two requests race or the process dies mid-write.
   */
  async putOnce(key: string, bytes: Buffer): Promise<void> {
    const path = this.path(key);
    const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    await mkdir(dirname(path), { recursive: true, mode: 0o750 });
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o640 });
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      await unlink(temporary);
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.path(key));
      return true;
    } catch {
      return false;
    }
  }

  read(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }

  /** The nginx internal path of a file, or null when the API sends files itself. */
  accelPath(key: string): string | null {
    return this.accelPrefix ? `${this.accelPrefix}/${key}` : null;
  }

  private path(key: string): string {
    return pathUnderRoot(this.root, key);
  }
}

/**
 * The absolute path of a key under the files root; throws when the key leaves it. `paths` is the
 * platform's path module (posix or win32), so both separators are checked the same way.
 */
export function pathUnderRoot(root: string, key: string, paths: PlatformPath = path): string {
  const full = paths.resolve(root, key);
  const relative = paths.relative(root, full);
  if (relative === '' || relative.startsWith('..') || paths.isAbsolute(relative)) {
    throw new Error('A file key left the files root');
  }
  return full;
}
