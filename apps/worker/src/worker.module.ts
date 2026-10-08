import { Inject, Logger, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { TelegramAlerts } from './core/alerts/telegram-alerts.js';
import { ConfigModule } from './core/config/config.module.js';
import { ENV, type Env } from './core/config/env.js';
import { DatabaseModule } from './core/database/database.module.js';
import { Mailer } from './core/email/mailer.js';
import { PgBossService } from './core/jobs/pg-boss.service.js';
import { chainReadersProvider } from './jobs/deposits/chain/chain-readers.provider.js';
import { ExpireDepositsJob } from './jobs/deposits/expire.job.js';
import { UsdtScanJob } from './jobs/deposits/usdt-scan.job.js';
import { UsdtVerifyJob } from './jobs/deposits/usdt-verify.job.js';
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
    chainReadersProvider,
    UsdtVerifyJob,
    UsdtScanJob,
  ],
})
export class WorkerModule implements OnApplicationBootstrap {
  constructor(
    private readonly alerts: TelegramAlerts,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onApplicationBootstrap(): void {
    const logger = new Logger(WorkerModule.name);
    if (!this.alerts.enabled) {
      logger.warn('Telegram alerts are off (TELEGRAM_BOT_TOKEN unset)');
    }
    logger.log(
      `USDT: ${this.env.CHAIN_READER} readers; TRC20 ${this.env.USDT_TRC20_ADDRESS ? 'on' : 'off'}, BEP20 ${this.env.USDT_BEP20_ADDRESS ? 'on' : 'off'}`,
    );
  }
}
