import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_POOL_LIMITS, createDatabase, type DatabaseConnection } from '@vertex-digital/db';
import { ENV, type Env } from '../config/env.js';

/** Injection token for the Drizzle database (the app role, ADR 0014). */
export const DATABASE = Symbol('DATABASE');
const DATABASE_CONNECTION = Symbol('DATABASE_CONNECTION');

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_CONNECTION,
      inject: [ENV],
      useFactory: (env: Env) =>
        createDatabase(env.DATABASE_URL, { ...APP_POOL_LIMITS, max: env.DATABASE_POOL_MAX }),
    },
    {
      provide: DATABASE,
      inject: [DATABASE_CONNECTION],
      useFactory: (connection: DatabaseConnection) => connection.db,
    },
  ],
  exports: [DATABASE],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DATABASE_CONNECTION) private readonly connection: DatabaseConnection) {}

  async onApplicationShutdown(): Promise<void> {
    await this.connection.close();
  }
}
