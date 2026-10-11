import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  SerializeOptions,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  adminActivitySchema,
  announcementInputSchema,
  announcementSchema,
  type BannerOrder,
  bannerImageSchema,
  bannerInputSchema,
  bannerOrderSchema,
  bannerSchema,
  CATALOG_IMAGE_MAX_BYTES,
  type ContentListQuery,
  type ContentPage,
  type ContentRevision,
  type ContentSettings,
  contentListQuerySchema,
  contentRevisionSchema,
  contentSettingsSchema,
  enabledAnnouncementSchema,
  type FaqOrder,
  faqItemSchema,
  faqOrderSchema,
  faqPublicationSchema,
  faqSectionSchema,
  faqWorkingCopySchema,
  pageDraftSchema,
  pageSummarySchema,
  pageVersionSchema,
  type SaveFaqSection,
  saveFaqItemSchema,
  saveFaqSectionSchema,
  savePageDraftSchema,
} from '@vertex-digital/contracts';
import type { Request } from 'express';
import type { z } from 'zod';
import { AdminRoute, CurrentAdmin } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { requestMeta } from '../../core/http/request-meta.js';
import { StoreRevalidateInterceptor } from '../../core/jobs/index.js';
import { RateLimit } from '../../core/rate-limit/rate-limit.js';
import type { AdminIdentity } from '../admin/index.js';
import { uploadBody } from '../files/index.js';
import { ContentActivityService } from './content-activity.service.js';
import { ContentFaqService } from './content-faq.service.js';
import { ContentHomeService } from './content-home.service.js';
import { ContentPagePipe, PageVersionPipe } from './content-page.pipe.js';
import { ContentPagesService } from './content-pages.service.js';
import type { Actor } from './content-records.js';

const imageUpload = FileInterceptor('file', {
  limits: { fileSize: CATALOG_IMAGE_MAX_BYTES, files: 1, fields: 0 },
});

const actor = (admin: AdminIdentity, request: Request): Actor => ({
  adminId: admin.id,
  meta: requestMeta(request),
});

const archived = (query: ContentListQuery) => query.archived === 'true';

type BannerBody = z.output<typeof bannerInputSchema>;
type AnnouncementBody = z.output<typeof announcementInputSchema>;
type FaqItemBody = z.output<typeof saveFaqItemSchema>;
type PageDraftBody = z.output<typeof savePageDraftSchema>;

/**
 * Store content in the panel (S14 F21, F25): pages, the FAQ, banners, announcements and live
 * activity. No re-authentication (owner, 2026-10-11); every change refreshes the store (CP1).
 * Never cached.
 */
@ApiTags('content')
@UseInterceptors(StoreRevalidateInterceptor)
@Controller('admin/content')
export class ContentAdminController {
  constructor(
    private readonly pages: ContentPagesService,
    private readonly faq: ContentFaqService,
    private readonly home: ContentHomeService,
    private readonly activity: ContentActivityService,
  ) {}

  // Pages -----------------------------------------------------------------------------------------

  @Get('pages')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: pageSummarySchema })
  @ApiOkResponse({ description: 'The four pages', standardSchema: pageSummarySchema.array() })
  pageList() {
    return this.pages.summaries();
  }

  @Get('pages/:page')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: pageDraftSchema })
  @ApiOkResponse({ description: 'The draft and its versions', standardSchema: pageDraftSchema })
  pageDraft(@Param('page', ContentPagePipe) page: ContentPage) {
    return this.pages.draft(page);
  }

  @Get('pages/:page/versions/:version')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: pageVersionSchema })
  @ApiOkResponse({ description: 'A published version', standardSchema: pageVersionSchema })
  pageVersion(
    @Param('page', ContentPagePipe) page: ContentPage,
    @Param('version', PageVersionPipe) version: number,
  ) {
    return this.pages.version(page, version);
  }

  /** Rule PG3. */
  @Put('pages/:page/draft')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: pageDraftSchema })
  @ApiOkResponse({ description: 'The saved draft', standardSchema: pageDraftSchema })
  saveDraft(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('page', ContentPagePipe) page: ContentPage,
    @Body({ schema: savePageDraftSchema }) body: PageDraftBody,
    @Req() request: Request,
  ) {
    return this.pages.saveDraft(actor(admin, request), page, body);
  }

  /** Rule PG5. */
  @Post('pages/:page/publish')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: pageVersionSchema })
  @ApiCreatedResponse({ description: 'The new version', standardSchema: pageVersionSchema })
  publishPage(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('page', ContentPagePipe) page: ContentPage,
    @Body({ schema: contentRevisionSchema }) body: ContentRevision,
    @Req() request: Request,
  ) {
    return this.pages.publish(actor(admin, request), page, body.revision);
  }

  /** Rule PG6. */
  @Post('pages/:page/versions/:version/restore')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: pageDraftSchema })
  @ApiOkResponse({ description: 'The draft', standardSchema: pageDraftSchema })
  restoreVersion(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('page', ContentPagePipe) page: ContentPage,
    @Param('version', PageVersionPipe) version: number,
    @Body({ schema: contentRevisionSchema }) body: ContentRevision,
    @Req() request: Request,
  ) {
    return this.pages.restore(actor(admin, request), page, version, body.revision);
  }

  // FAQ -------------------------------------------------------------------------------------------

  @Get('faq')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(contentListQuerySchema)
  @SerializeOptions({ schema: faqWorkingCopySchema })
  @ApiOkResponse({ description: 'The working copy', standardSchema: faqWorkingCopySchema })
  faqWorkingCopy(@Query({ schema: contentListQuerySchema }) query: ContentListQuery) {
    return this.faq.workingCopy(archived(query));
  }

  @Post('faq/sections')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: faqSectionSchema })
  @ApiCreatedResponse({ description: 'Last in the order', standardSchema: faqSectionSchema })
  createSection(
    @CurrentAdmin() admin: AdminIdentity,
    @Body({ schema: saveFaqSectionSchema }) body: SaveFaqSection,
    @Req() request: Request,
  ) {
    return this.faq.createSection(actor(admin, request), body);
  }

  @Patch('faq/sections/:id')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: faqSectionSchema })
  @ApiOkResponse({ description: 'The section', standardSchema: faqSectionSchema })
  updateSection(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body({ schema: saveFaqSectionSchema }) body: SaveFaqSection,
    @Req() request: Request,
  ) {
    return this.faq.updateSection(actor(admin, request), id, body);
  }

  @Post('faq/sections/:id/archive')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: faqSectionSchema })
  @ApiOkResponse({ description: 'The section', standardSchema: faqSectionSchema })
  archiveSection(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ) {
    return this.faq.archiveSection(actor(admin, request), id);
  }

  @Post('faq/sections/:id/restore')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: faqSectionSchema })
  @ApiOkResponse({ description: 'The section', standardSchema: faqSectionSchema })
  restoreSection(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ) {
    return this.faq.restoreSection(actor(admin, request), id);
  }

  @Post('faq/items')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: faqItemSchema })
  @ApiCreatedResponse({ description: 'Last in its section', standardSchema: faqItemSchema })
  createItem(
    @CurrentAdmin() admin: AdminIdentity,
    @Body({ schema: saveFaqItemSchema }) body: FaqItemBody,
    @Req() request: Request,
  ) {
    return this.faq.createItem(actor(admin, request), body);
  }

  @Patch('faq/items/:id')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: faqItemSchema })
  @ApiOkResponse({ description: 'The question', standardSchema: faqItemSchema })
  updateItem(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body({ schema: saveFaqItemSchema }) body: FaqItemBody,
    @Req() request: Request,
  ) {
    return this.faq.updateItem(actor(admin, request), id, body);
  }

  @Post('faq/items/:id/archive')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: faqItemSchema })
  @ApiOkResponse({ description: 'The question', standardSchema: faqItemSchema })
  archiveItem(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ) {
    return this.faq.archiveItem(actor(admin, request), id);
  }

  @Post('faq/items/:id/restore')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: faqItemSchema })
  @ApiOkResponse({ description: 'The question', standardSchema: faqItemSchema })
  restoreItem(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ) {
    return this.faq.restoreItem(actor(admin, request), id);
  }

  /** Rule FQ4. */
  @Put('faq/order')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: faqWorkingCopySchema })
  @ApiOkResponse({ description: 'The working copy', standardSchema: faqWorkingCopySchema })
  reorderFaq(
    @CurrentAdmin() admin: AdminIdentity,
    @Body({ schema: faqOrderSchema }) body: FaqOrder,
    @Req() request: Request,
  ) {
    return this.faq.reorder(actor(admin, request), body);
  }

  /** Rule FQ6. */
  @Post('faq/publish')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: faqPublicationSchema })
  @ApiCreatedResponse({ description: 'The publication', standardSchema: faqPublicationSchema })
  publishFaq(
    @CurrentAdmin() admin: AdminIdentity,
    @Body({ schema: contentRevisionSchema }) body: ContentRevision,
    @Req() request: Request,
  ) {
    return this.faq.publish(actor(admin, request), body.revision);
  }

  // Banners ---------------------------------------------------------------------------------------

  /** Rule BN2: re-encoded to WebP; the banner form saves the returned id. */
  @Post('banners/image')
  @AdminRoute()
  @RateLimit({ limit: 30, perSeconds: 60 })
  @UseInterceptors(imageUpload)
  @Header('cache-control', 'no-store')
  @ApiConsumes('multipart/form-data')
  @ApiBody(uploadBody())
  @SerializeOptions({ schema: bannerImageSchema })
  @ApiCreatedResponse({ description: 'The stored image', standardSchema: bannerImageSchema })
  uploadBannerImage(@UploadedFile() file: { buffer: Buffer } | undefined) {
    return this.home.uploadBannerImage(file?.buffer);
  }

  @Get('banners')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(contentListQuerySchema)
  @SerializeOptions({ schema: bannerSchema })
  @ApiOkResponse({ description: 'In their order', standardSchema: bannerSchema.array() })
  bannerList(@Query({ schema: contentListQuerySchema }) query: ContentListQuery) {
    return this.home.banners(archived(query));
  }

  @Post('banners')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: bannerSchema })
  @ApiCreatedResponse({ description: 'Disabled, last in the order', standardSchema: bannerSchema })
  createBanner(
    @CurrentAdmin() admin: AdminIdentity,
    @Body({ schema: bannerInputSchema }) body: BannerBody,
    @Req() request: Request,
  ) {
    return this.home.createBanner(actor(admin, request), body);
  }

  /** Rule BN6. */
  @Put('banners/order')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: bannerSchema })
  @ApiOkResponse({ description: 'In their new order', standardSchema: bannerSchema.array() })
  reorderBanners(
    @CurrentAdmin() admin: AdminIdentity,
    @Body({ schema: bannerOrderSchema }) body: BannerOrder,
    @Req() request: Request,
  ) {
    return this.home.reorderBanners(actor(admin, request), body.ids);
  }

  @Patch('banners/:id')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: bannerSchema })
  @ApiOkResponse({ description: 'The banner', standardSchema: bannerSchema })
  updateBanner(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body({ schema: bannerInputSchema }) body: BannerBody,
    @Req() request: Request,
  ) {
    return this.home.updateBanner(actor(admin, request), id, body);
  }

  @Post('banners/:id/enable')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: bannerSchema })
  @ApiOkResponse({ description: 'The banner', standardSchema: bannerSchema })
  enableBanner(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ) {
    return this.home.enableBanner(actor(admin, request), id);
  }

  @Post('banners/:id/disable')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: bannerSchema })
  @ApiOkResponse({ description: 'The banner', standardSchema: bannerSchema })
  disableBanner(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ) {
    return this.home.disableBanner(actor(admin, request), id);
  }

  @Post('banners/:id/archive')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: bannerSchema })
  @ApiOkResponse({ description: 'The banner', standardSchema: bannerSchema })
  archiveBanner(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ) {
    return this.home.archiveBanner(actor(admin, request), id);
  }

  @Post('banners/:id/restore')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: bannerSchema })
  @ApiOkResponse({ description: 'The banner', standardSchema: bannerSchema })
  restoreBanner(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ) {
    return this.home.restoreBanner(actor(admin, request), id);
  }

  // Announcements ---------------------------------------------------------------------------------

  @Get('announcements')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(contentListQuerySchema)
  @SerializeOptions({ schema: announcementSchema })
  @ApiOkResponse({ description: 'Enabled first', standardSchema: announcementSchema.array() })
  announcementList(@Query({ schema: contentListQuerySchema }) query: ContentListQuery) {
    return this.home.announcements(archived(query));
  }

  @Post('announcements')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: announcementSchema })
  @ApiCreatedResponse({ description: 'Disabled', standardSchema: announcementSchema })
  createAnnouncement(
    @CurrentAdmin() admin: AdminIdentity,
    @Body({ schema: announcementInputSchema }) body: AnnouncementBody,
    @Req() request: Request,
  ) {
    return this.home.createAnnouncement(actor(admin, request), body);
  }

  @Patch('announcements/:id')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: announcementSchema })
  @ApiOkResponse({ description: 'The announcement', standardSchema: announcementSchema })
  updateAnnouncement(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body({ schema: announcementInputSchema }) body: AnnouncementBody,
    @Req() request: Request,
  ) {
    return this.home.updateAnnouncement(actor(admin, request), id, body);
  }

  /** Rule AN2: names the announcement it disabled. */
  @Post('announcements/:id/enable')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: enabledAnnouncementSchema })
  @ApiOkResponse({ description: 'The announcement', standardSchema: enabledAnnouncementSchema })
  enableAnnouncement(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ) {
    return this.home.enableAnnouncement(actor(admin, request), id);
  }

  @Post('announcements/:id/disable')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: announcementSchema })
  @ApiOkResponse({ description: 'The announcement', standardSchema: announcementSchema })
  disableAnnouncement(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ) {
    return this.home.disableAnnouncement(actor(admin, request), id);
  }

  @Post('announcements/:id/archive')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: announcementSchema })
  @ApiOkResponse({ description: 'The announcement', standardSchema: announcementSchema })
  archiveAnnouncement(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ) {
    return this.home.archiveAnnouncement(actor(admin, request), id);
  }

  @Post('announcements/:id/restore')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: announcementSchema })
  @ApiOkResponse({ description: 'The announcement', standardSchema: announcementSchema })
  restoreAnnouncement(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ) {
    return this.home.restoreAnnouncement(actor(admin, request), id);
  }

  // Live activity ---------------------------------------------------------------------------------

  @Get('settings')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: contentSettingsSchema })
  @ApiOkResponse({ description: 'The content settings', standardSchema: contentSettingsSchema })
  settings() {
    return this.activity.settings();
  }

  /** Rule LA6. */
  @Put('settings')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: contentSettingsSchema })
  @ApiOkResponse({ description: 'The content settings', standardSchema: contentSettingsSchema })
  updateSettings(
    @CurrentAdmin() admin: AdminIdentity,
    @Body({ schema: contentSettingsSchema }) body: ContentSettings,
    @Req() request: Request,
  ) {
    return this.activity.updateSettings(actor(admin, request), body);
  }

  @Get('activity')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: adminActivitySchema })
  @ApiOkResponse({
    description: 'The feed as the store shows it',
    standardSchema: adminActivitySchema,
  })
  activityPreview() {
    return this.activity.preview();
  }
}
