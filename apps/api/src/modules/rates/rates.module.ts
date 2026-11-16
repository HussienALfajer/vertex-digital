import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/index.js';
import { RateSettingsService } from './rate-settings.service.js';
import { RateSourcesAdminController } from './rate-sources.admin.controller.js';
import { RateSourcesService } from './rate-sources.service.js';
import { RateSuggestionsAdminController } from './rate-suggestions.admin.controller.js';
import { RateSuggestionsService } from './rate-suggestions.service.js';
import { RatesAdminController } from './rates.admin.controller.js';
import { RatesService } from './rates.service.js';

/**
 * Exchange rates (S03 F04, S27 F46): `exchange_rates`, `rate_sources`, `rate_observations`,
 * `rate_suggestions`, `rate_settings`. The admin's rate and display step with their history, the
 * automatic updates' sources, suggestions and settings; other modules read the rate in force
 * through `RatesService.current()`, and the Telegram bot decides suggestions and turns automatic
 * updates off through `RateSuggestionsService` and `RateSettingsService`. The worker reads the
 * sources and writes automatic rates (`rates.poll`).
 */
@Module({
  imports: [AdminModule],
  controllers: [RatesAdminController, RateSourcesAdminController, RateSuggestionsAdminController],
  providers: [RatesService, RateSourcesService, RateSuggestionsService, RateSettingsService],
  exports: [RatesService, RateSuggestionsService, RateSettingsService],
})
export class RatesModule {}
