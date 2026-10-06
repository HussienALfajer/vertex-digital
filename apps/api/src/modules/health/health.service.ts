import { Inject, Injectable } from '@nestjs/common';
import type { HealthResponse } from '@vertex-digital/contracts';
import type { Database } from '@vertex-digital/db';
import { sql } from 'drizzle-orm';
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
}
