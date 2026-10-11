import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/index.js';
import { FilesModule } from '../files/index.js';
import { ContentAdminController } from './content.admin.controller.js';
import { ContentController } from './content.controller.js';
import { ContentActivityService } from './content-activity.service.js';
import { ContentFaqService } from './content-faq.service.js';
import { ContentHomeService } from './content-home.service.js';
import { ContentPagesService } from './content-pages.service.js';

/**
 * Store content and live activity (S14 F21, F25): `content_page_drafts`, `content_page_versions`,
 * `faq_sections`, `faq_items`, `faq_publications`, `banners`, `announcements`, `content_settings`.
 * Live activity and the customers' accepted versions are read through `packages/db/src/content`,
 * which reads the orders, catalog and customers tables for it.
 */
@Module({
  imports: [AdminModule, FilesModule],
  controllers: [ContentController, ContentAdminController],
  providers: [ContentPagesService, ContentFaqService, ContentHomeService, ContentActivityService],
})
export class ContentModule {}
