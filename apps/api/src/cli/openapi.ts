/**
 * Writes the OpenAPI document to apps/api/openapi.json, from which the admin panel generates its
 * typed client (ADR 0011). CI fails when the committed file is out of date.
 *
 *   pnpm --filter @vertex-digital/api openapi:export
 */
import { writeFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { loadRootEnv } from '@vertex-digital/db';
import { AppModule } from '../app.module.js';
import { API_PREFIX, createOpenApiDocument } from '../app.setup.js';

loadRootEnv();

const target = new URL('../../openapi.json', import.meta.url);
// No request is served, so no database connection is opened.
const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
app.setGlobalPrefix(API_PREFIX);
writeFileSync(target, `${JSON.stringify(createOpenApiDocument(app), null, 2)}\n`);
await app.close();
process.stdout.write(`Wrote ${target.pathname}\n`);
