import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
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

  /** Writes a derived file (an image width, S09) unless another request wrote it first. */
  async putOnce(key: string, bytes: Buffer): Promise<void> {
    try {
      await this.put(key, bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
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
    const path = resolve(this.root, key);
    if (!path.startsWith(`${this.root}/`)) throw new Error('A file key left the files root');
    return path;
  }
}
