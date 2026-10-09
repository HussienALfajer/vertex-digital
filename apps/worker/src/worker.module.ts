import { Inject, Logger, Module, type OnApplicationBootstrap } from '@nestjs/common';
import type { Database } from '@vertex-digital/db';
import { LoggerModule } from 'nestjs-pino';
import { TelegramAlerts } from './core/alerts/telegram-alerts.js';
import { ConfigModule } from './core/config/config.module.js';
import { ENV, type Env } from './core/config/env.js';
import { LOG_REDACT_PATHS } from './core/config/log-redact.js';
import { DATABASE, DatabaseModule } from './core/database/database.module.js';
import { Mailer } from './core/email/mailer.js';
import { PgBossService } from './core/jobs/pg-boss.service.js';
import { chainReadersProvider } from './jobs/deposits/chain/chain-readers.provider.js';
import { ExpireDepositsJob } from './jobs/deposits/expire.job.js';
import { UsdtScanJob } from './jobs/deposits/usdt-scan.job.js';
import { UsdtVerifyJob } from './jobs/deposits/usdt-verify.job.js';
import { PurgeCodesJob } from './jobs/email/purge-codes.job.js';
import { SendEmailJob } from './jobs/email/send-email.job.js';
import { OrdersFulfilJob } from './jobs/orders/fulfil.job.js';
import { OrdersPayWaitingJob } from './jobs/orders/pay-waiting.job.js';
import { OrdersPollJob } from './jobs/orders/poll.job.js';
import { OrdersSweepJob } from './jobs/orders/sweep.job.js';
import { OrdersWaitingSweepJob } from './jobs/orders/waiting-sweep.job.js';
import { StoreRevalidateJob } from './jobs/store/revalidate.job.js';
import { SupplierBalancesJob } from './jobs/suppliers/balances.job.js';
import { SupplierHealthJob } from './jobs/suppliers/health.job.js';
import { SupplierSyncJob } from './jobs/suppliers/sync.job.js';
import { SupplierSyncScheduleJob } from './jobs/suppliers/sync-schedule.job.js';
import { SupplierWebhookJob } from './jobs/suppliers/webhook.job.js';
import { HeartbeatJob } from './jobs/system/heartbeat.job.js';
import { DailySummaryJob } from './jobs/telegram/daily-summary.job.js';
import { DepositCardJob } from './jobs/telegram/deposit-card.job.js';
import { ReviewReminderJob } from './jobs/telegram/review-reminder.job.js';
import { SendTelegramJob } from './jobs/telegram/send.job.js';
import { SupplierRegistry } from './suppliers/supplier-registry.js';
import { TelegramBot } from './telegram/bot-api.js';
import { LinkedChat } from './telegram/linked-chat.js';
import { TelegramWebhookSetup } from './telegram/webhook-setup.js';

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
  ],
  providers: [
    {
      provide: TelegramBot,
      inject: [ENV],
      useFactory: (env: Env) =>
        new TelegramBot({
          transport: env.TELEGRAM_TRANSPORT,
          botToken: env.TELEGRAM_BOT_TOKEN,
          apiUrl: env.TELEGRAM_API_URL,
          logDir: env.TELEGRAM_LOG_DIR,
        }),
    },
    { provide: LinkedChat, inject: [DATABASE], useFactory: (db: Database) => new LinkedChat(db) },
    {
      provide: TelegramAlerts,
      inject: [ENV, TelegramBot, LinkedChat],
      useFactory: (env: Env, bot: TelegramBot, chat: LinkedChat) =>
        new TelegramAlerts({ source: `worker ${env.WORKER_NAME}` }, bot, () => chat.chatId()),
    },
    TelegramWebhookSetup,
    PgBossService,
    Mailer,
    HeartbeatJob,
    SendEmailJob,
    PurgeCodesJob,
    ExpireDepositsJob,
    chainReadersProvider,
    UsdtVerifyJob,
    UsdtScanJob,
    SendTelegramJob,
    DepositCardJob,
    ReviewReminderJob,
    DailySummaryJob,
    SupplierRegistry,
    SupplierSyncJob,
    SupplierSyncScheduleJob,
    SupplierBalancesJob,
    SupplierHealthJob,
    OrdersFulfilJob,
    OrdersPollJob,
    OrdersSweepJob,
    OrdersPayWaitingJob,
    OrdersWaitingSweepJob,
    SupplierWebhookJob,
    StoreRevalidateJob,
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
      logger.warn('Telegram is off (TELEGRAM_BOT_TOKEN unset): messages are skipped');
    }
    if (this.env.SUPPLIER_FAKE_ENABLED) logger.warn('The fake supplier is enabled (S07)');
    logger.log(
      `USDT: ${this.env.CHAIN_READER} readers; TRC20 ${this.env.USDT_TRC20_ADDRESS ? 'on' : 'off'}, BEP20 ${this.env.USDT_BEP20_ADDRESS ? 'on' : 'off'}`,
    );
  }
}
