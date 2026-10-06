import './instrument.js';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { ENV, type Env } from './core/config/env.js';

const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
configureApp(app);
app.enableShutdownHooks();

const env = app.get<Env>(ENV);
await app.listen(env.API_PORT, env.API_HOST);
