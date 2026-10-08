import { Module, StandardSchemaSerializerInterceptor } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
// Straight from the file: the guard reads the modules, whose controllers use `core/access`.
import { AccessGuard } from './core/access/access.guard.js';
import { AltchaGuard, AltchaModule } from './core/altcha/index.js';
import { ConfigModule } from './core/config/config.module.js';
import { ENV, type Env } from './core/config/env.js';
import { DatabaseModule } from './core/database/database.module.js';
import { createValidationPipe, ErrorFilter } from './core/errors/index.js';
import { LOG_REDACT_PATHS } from './core/http/secret-headers.js';
import { JobsModule } from './core/jobs/index.js';
import { throttlerOptions } from './core/rate-limit/rate-limit.js';
import { AdminModule } from './modules/admin/index.js';
import { AuditModule } from './modules/audit/index.js';
import { AuthModule } from './modules/auth/index.js';
import { CatalogModule } from './modules/catalog/index.js';
import { DepositsModule } from './modules/deposits/index.js';
import { FilesModule } from './modules/files/index.js';
import { HealthModule } from './modules/health/index.js';
import { NotificationsModule } from './modules/notifications/index.js';
import { PricingModule } from './modules/pricing/index.js';
import { RatesModule } from './modules/rates/index.js';
import { SettingsModule } from './modules/settings/index.js';
import { TelegramModule } from './modules/telegram/index.js';
import { WalletModule } from './modules/wallet/index.js';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        pinoHttp: {
          level: env.LOG_LEVEL,
          redact: LOG_REDACT_PATHS,
          ...(env.NODE_ENV === 'development' && { transport: { target: 'pino-pretty' } }),
        },
      }),
    }),
    DatabaseModule,
    JobsModule,
    ThrottlerModule.forRoot(throttlerOptions),
    AltchaModule,
    NotificationsModule,
    SettingsModule,
    AuthModule,
    AdminModule,
    AuditModule,
    RatesModule,
    WalletModule,
    FilesModule,
    DepositsModule,
    CatalogModule,
    PricingModule,
    TelegramModule,
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
