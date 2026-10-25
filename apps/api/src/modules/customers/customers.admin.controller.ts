import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  SerializeOptions,
} from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  adminCustomerPageSchema,
  adminCustomerSchema,
  auditPageSchema,
  type CursorQuery,
  type CustomerNoteListQuery,
  type CustomerSearchQuery,
  type CustomerStateChange,
  createCustomerNoteSchema,
  cursorQuerySchema,
  customerLimitsSchema,
  customerNoteListQuerySchema,
  customerNotePageSchema,
  customerNoteSchema,
  customerSearchQuerySchema,
  customerSessionListSchema,
  customerSessionSchema,
  customerSignInPageSchema,
  customerStateChangeSchema,
  passkeyListSchema,
  passkeySchema,
  type SetCustomerPriceList,
  setCustomerPriceListSchema,
  type UpdateCustomerLimits,
  updateCustomerLimitsSchema,
} from '@vertex-digital/contracts';
import type { Request } from 'express';
import type { z } from 'zod';
import { AdminRoute, CurrentAdmin, Sensitive } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { requestMeta } from '../../core/http/request-meta.js';
import type { AdminIdentity } from '../admin/index.js';
import { type CustomerStateAction, CustomersService } from './customers.service.js';

/**
 * Customer administration (S12 F19): the search, the profile and its tabs, and the actions menu.
 * State and limit changes need a recent re-authentication and a reason; notes do not (SN2).
 */
@ApiTags('customers')
@Controller('admin/customers')
export class CustomersAdminController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(customerSearchQuerySchema)
  @SerializeOptions({ schema: adminCustomerPageSchema })
  @ApiOkResponse({ description: 'Newest first', standardSchema: adminCustomerPageSchema })
  search(@Query({ schema: customerSearchQuerySchema }) query: CustomerSearchQuery) {
    return this.customers.search(query);
  }

  @Get(':id')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: adminCustomerSchema })
  @ApiOkResponse({ description: 'The profile', standardSchema: adminCustomerSchema })
  profile(@Param('id') id: string) {
    return this.customers.profile(id);
  }

  @Get(':id/sign-ins')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(cursorQuerySchema)
  @SerializeOptions({ schema: customerSignInPageSchema })
  @ApiOkResponse({ description: 'Newest first', standardSchema: customerSignInPageSchema })
  signIns(@Param('id') id: string, @Query({ schema: cursorQuerySchema }) query: CursorQuery) {
    return this.customers.signIns(id, query);
  }

  @Get(':id/sessions')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: customerSessionSchema })
  @ApiOkResponse({ description: 'Sessions not expired', standardSchema: customerSessionListSchema })
  sessions(@Param('id') id: string) {
    return this.customers.sessions(id);
  }

  @Get(':id/passkeys')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: passkeySchema })
  @ApiOkResponse({ description: 'Oldest first (S22 PK6)', standardSchema: passkeyListSchema })
  passkeys(@Param('id') id: string) {
    return this.customers.passkeys(id);
  }

  @Get(':id/history')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(cursorQuerySchema)
  @SerializeOptions({ schema: auditPageSchema })
  @ApiOkResponse({ description: 'Newest first', standardSchema: auditPageSchema })
  history(@Param('id') id: string, @Query({ schema: cursorQuerySchema }) query: CursorQuery) {
    return this.customers.history(id, query);
  }

  @Get(':id/notes')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(customerNoteListQuerySchema)
  @SerializeOptions({ schema: customerNotePageSchema })
  @ApiOkResponse({ description: 'Newest first', standardSchema: customerNotePageSchema })
  notes(
    @Param('id') id: string,
    @Query({ schema: customerNoteListQuerySchema }) query: CustomerNoteListQuery,
  ) {
    return this.customers.notes(id, query);
  }

  @Post(':id/freeze')
  @AdminRoute()
  @Sensitive()
  @HttpCode(200)
  @SerializeOptions({ schema: adminCustomerSchema })
  @ApiOkResponse({ description: 'Frozen (CF1)', standardSchema: adminCustomerSchema })
  freeze(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @Body({ schema: customerStateChangeSchema }) body: CustomerStateChange,
    @Req() request: Request,
  ) {
    return this.change('freeze', admin, id, body, request);
  }

  @Post(':id/unfreeze')
  @AdminRoute()
  @Sensitive()
  @HttpCode(200)
  @SerializeOptions({ schema: adminCustomerSchema })
  @ApiOkResponse({ description: 'Unfrozen (CF6)', standardSchema: adminCustomerSchema })
  unfreeze(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @Body({ schema: customerStateChangeSchema }) body: CustomerStateChange,
    @Req() request: Request,
  ) {
    return this.change('unfreeze', admin, id, body, request);
  }

  @Post(':id/archive')
  @AdminRoute()
  @Sensitive()
  @HttpCode(200)
  @SerializeOptions({ schema: adminCustomerSchema })
  @ApiOkResponse({ description: 'Archived (AR1, AR2)', standardSchema: adminCustomerSchema })
  archive(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @Body({ schema: customerStateChangeSchema }) body: CustomerStateChange,
    @Req() request: Request,
  ) {
    return this.change('archive', admin, id, body, request);
  }

  @Post(':id/unarchive')
  @AdminRoute()
  @Sensitive()
  @HttpCode(200)
  @SerializeOptions({ schema: adminCustomerSchema })
  @ApiOkResponse({ description: 'Unarchived (AR3)', standardSchema: adminCustomerSchema })
  unarchive(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @Body({ schema: customerStateChangeSchema }) body: CustomerStateChange,
    @Req() request: Request,
  ) {
    return this.change('unarchive', admin, id, body, request);
  }

  @Post(':id/sessions/revoke')
  @AdminRoute()
  @Sensitive()
  @HttpCode(200)
  @SerializeOptions({ schema: adminCustomerSchema })
  @ApiOkResponse({
    description: 'Signed out everywhere (SN1)',
    standardSchema: adminCustomerSchema,
  })
  revokeSessions(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @Body({ schema: customerStateChangeSchema }) body: CustomerStateChange,
    @Req() request: Request,
  ) {
    return this.change('revokeSessions', admin, id, body, request);
  }

  @Put(':id/limits')
  @AdminRoute()
  @Sensitive()
  @SerializeOptions({ schema: customerLimitsSchema })
  @ApiOkResponse({ description: 'The limits in force (LM5)', standardSchema: customerLimitsSchema })
  limits(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @Body({ schema: updateCustomerLimitsSchema }) body: UpdateCustomerLimits,
    @Req() request: Request,
  ) {
    return this.customers.setLimits(id, body, admin.id, requestMeta(request));
  }

  @Post(':id/notes')
  @AdminRoute()
  @SerializeOptions({ schema: customerNoteSchema })
  @ApiOkResponse({ description: 'Added (SN2)', standardSchema: customerNoteSchema })
  addNote(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @Body({ schema: createCustomerNoteSchema }) body: z.output<typeof createCustomerNoteSchema>,
    @Req() request: Request,
  ) {
    return this.customers.addNote(id, body, admin.id, requestMeta(request));
  }

  @Post(':id/notes/:noteId/pin')
  @AdminRoute()
  @HttpCode(200)
  @SerializeOptions({ schema: customerNoteSchema })
  @ApiOkResponse({ description: 'Pinned (SN2)', standardSchema: customerNoteSchema })
  pinNote(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @Param('noteId') noteId: string,
    @Req() request: Request,
  ) {
    return this.customers.changeNote(id, noteId, 'pin', admin.id, requestMeta(request));
  }

  @Post(':id/notes/:noteId/unpin')
  @AdminRoute()
  @HttpCode(200)
  @SerializeOptions({ schema: customerNoteSchema })
  @ApiOkResponse({ description: 'Unpinned (SN2)', standardSchema: customerNoteSchema })
  unpinNote(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @Param('noteId') noteId: string,
    @Req() request: Request,
  ) {
    return this.customers.changeNote(id, noteId, 'unpin', admin.id, requestMeta(request));
  }

  @Post(':id/notes/:noteId/archive')
  @AdminRoute()
  @HttpCode(200)
  @SerializeOptions({ schema: customerNoteSchema })
  @ApiOkResponse({ description: 'Archived (SN2)', standardSchema: customerNoteSchema })
  archiveNote(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @Param('noteId') noteId: string,
    @Req() request: Request,
  ) {
    return this.customers.changeNote(id, noteId, 'archive', admin.id, requestMeta(request));
  }

  /** S20 AT2, AT3. */
  @Put(':id/price-list')
  @AdminRoute()
  @Sensitive()
  @SerializeOptions({ schema: adminCustomerSchema })
  @ApiOkResponse({
    description: 'The profile with its new list (AT2)',
    standardSchema: adminCustomerSchema,
  })
  priceList(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @Body({ schema: setCustomerPriceListSchema }) body: SetCustomerPriceList,
    @Req() request: Request,
  ) {
    return this.customers.setPriceList(id, body, admin.id, requestMeta(request));
  }

  private change(
    action: CustomerStateAction,
    admin: AdminIdentity,
    id: string,
    body: CustomerStateChange,
    request: Request,
  ) {
    return this.customers.changeState(action, id, body.reason, admin.id, requestMeta(request));
  }
}
