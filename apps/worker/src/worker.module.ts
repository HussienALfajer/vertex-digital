import { Logger, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { TelegramAlerts } from './core/alerts/telegram-alerts.js';
import { ConfigModule } from './core/config/config.module.js';
import { ENV, type Env } from './core/config/env.js';
import { DatabaseModule } from './core/database/database.module.js';
import { Mailer } from './core/email/mailer.js';
import { PgBossService } from './core/jobs/pg-boss.service.js';
import { ExpireDepositsJob } from './jobs/deposits/expire.job.js';
import { PurgeCodesJob } from './jobs/email/purge-codes.job.js';
import { SendEmailJob } from './jobs/email/send-email.job.js';
import { HeartbeatJob } from './jobs/system/heartbeat.job.js';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        pinoHttp: {
          level: env.LOG_LEVEL,
          ...(env.NODE_ENV === 'development' && { transport: { target: 'pino-pretty' } }),
        },
      }),
    }),
    DatabaseModule,
  ],
  providers: [
    {
      provide: TelegramAlerts,
      inject: [ENV],
      useFactory: (env: Env) =>
        new TelegramAlerts({
          botToken: env.TELEGRAM_BOT_TOKEN,
          chatId: env.TELEGRAM_ALERTS_CHAT_ID,
          apiUrl: env.TELEGRAM_API_URL,
          source: `worker ${env.WORKER_NAME}`,
        }),
    },
    PgBossService,
    Mailer,
    HeartbeatJob,
    SendEmailJob,
    PurgeCodesJob,
    ExpireDepositsJob,
  ],
})
export class WorkerModule implements OnApplicationBootstrap {
  constructor(private readonly alerts: TelegramAlerts) {}

  onApplicationBootstrap(): void {
    if (!this.alerts.enabled) {
      new Logger(WorkerModule.name).warn('Telegram alerts are off (TELEGRAM_BOT_TOKEN unset)');
    }
  }
}
