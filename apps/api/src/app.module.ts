import { Module, StandardSchemaSerializerInterceptor } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AccessGuard } from './core/access/index.js';
import { AltchaGuard, AltchaModule } from './core/altcha/index.js';
import { ConfigModule } from './core/config/config.module.js';
import { ENV, type Env } from './core/config/env.js';
import { DatabaseModule } from './core/database/database.module.js';
import { createValidationPipe, ErrorFilter } from './core/errors/index.js';
import { throttlerOptions } from './core/rate-limit/rate-limit.js';
import { AdminModule } from './modules/admin/index.js';
import { AuthModule } from './modules/auth/index.js';
import { HealthModule } from './modules/health/index.js';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        pinoHttp: {
          level: env.LOG_LEVEL,
          redact: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.headers["x-altcha"]',
            'res.headers["set-cookie"]',
          ],
          ...(env.NODE_ENV === 'development' && { transport: { target: 'pino-pretty' } }),
        },
      }),
    }),
    DatabaseModule,
    ThrottlerModule.forRoot(throttlerOptions),
    AltchaModule,
    AuthModule,
    AdminModule,
    HealthModule,
  ],
  providers: [
    // Validates every parameter declared with `{ schema }` (Zod through Standard Schema).
    { provide: APP_PIPE, useFactory: createValidationPipe },
    // Shapes responses declared with `@SerializeOptions({ schema })`, dropping unknown fields.
    { provide: APP_INTERCEPTOR, useClass: StandardSchemaSerializerInterceptor },
    // Every error answers `{ statusCode, code, message }` (ADR 0011).
    { provide: APP_FILTER, useClass: ErrorFilter },
    // Guards run in this order: rate limit, access (ADR 0007), then ALTCHA (ADR 0008).
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AccessGuard },
    { provide: APP_GUARD, useClass: AltchaGuard },
  ],
})
export class AppModule {}
