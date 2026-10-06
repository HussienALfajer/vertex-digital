import type { Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Database } from '@vertex-digital/db';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { DATABASE } from '../src/core/database/database.module.js';

export interface TestApp {
  app: NestExpressApplication;
  url: string;
  db: Database;
}

/** Starts the real application on a random local port, configured like `main.ts`. */
export async function startApp(options: { controllers?: Type[] } = {}): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: options.controllers ?? [],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  return { app, url: await app.getUrl(), db: app.get<Database>(DATABASE) };
}
