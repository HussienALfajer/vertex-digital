import { Inject, Injectable } from '@nestjs/common';
import type { HealthResponse } from '@vertex-digital/contracts';
import { type Database, workerHeartbeats } from '@vertex-digital/db';
import { max, sql } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';

@Injectable()
export class HealthService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async check(): Promise<HealthResponse> {
    const databaseUp = await this.db.execute(sql`select 1`).then(
      () => true,
      () => false,
    );
    return {
      status: databaseUp ? 'ok' : 'error',
      checks: { database: databaseUp ? 'up' : 'down' },
      timestamp: new Date().toISOString(),
    };
  }

  /** The newest worker heartbeat, or null when no worker ever ran (the dashboard, audit A10-53). */
  async lastWorkerBeat(): Promise<Date | null> {
    const [row] = await this.db.select({ at: max(workerHeartbeats.beatAt) }).from(workerHeartbeats);
    return row?.at ?? null;
  }
}
