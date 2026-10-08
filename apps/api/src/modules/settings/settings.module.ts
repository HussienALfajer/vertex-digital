import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/index.js';
import { SettingsAdminController } from './settings.admin.controller.js';
import { SettingsController } from './settings.controller.js';
import { SettingsService } from './settings.service.js';

/**
 * Store settings (S05 F26): `store_switch_changes`. The switches with their history; other
 * modules read them through `SettingsService`. Below the domain modules: it imports none.
 */
@Module({
  imports: [AdminModule],
  controllers: [SettingsController, SettingsAdminController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
