import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
  Req,
  Res,
  SerializeOptions,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  adjustmentSchema,
  adminWalletEntryPageSchema,
  adminWalletSchema,
  createAdjustmentSchema,
  ledgerSummarySchema,
  reverseAdjustmentSchema,
  type WalletEntryQuery,
  type WalletSearchQuery,
  walletEntryQuerySchema,
  walletSearchPageSchema,
  walletSearchQuerySchema,
} from '@vertex-digital/contracts';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { AdminRoute, CurrentAdmin, Sensitive } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { ApiIdempotencyKey, IdempotencyKey } from '../../core/http/idempotency-key.js';
import { requestMeta } from '../../core/http/request-meta.js';
import type { AdminIdentity } from '../admin/index.js';
import { WalletService } from './wallet.service.js';
import { WalletAdjustmentsService } from './wallet-adjustments.service.js';

/**
 * The admin's wallet screens and adjustments (S02). Adjusting and reversing need a recent
 * re-authentication (rule J7) and an `Idempotency-Key` (rule J9): `201` when written, `200` when
 * the key replays an earlier request.
 */
@ApiTags('wallets')
@Controller('admin')
export class WalletAdminController {
  constructor(
    private readonly wallets: WalletService,
    private readonly adjustments: WalletAdjustmentsService,
  ) {}

  @Get('wallets')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(walletSearchQuerySchema)
  @SerializeOptions({ schema: walletSearchPageSchema })
  @ApiOkResponse({ description: 'Newest customers first', standardSchema: walletSearchPageSchema })
  search(@Query({ schema: walletSearchQuerySchema }) query: WalletSearchQuery) {
    return this.wallets.search(query.q, query);
  }

  @Get('wallets/:customerId')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: adminWalletSchema })
  @ApiOkResponse({ description: 'The wallet and its customer', standardSchema: adminWalletSchema })
  wallet(@Param('customerId') customerId: string) {
    return this.wallets.adminWallet(customerId);
  }

  @Get('wallets/:customerId/entries')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(walletEntryQuerySchema)
  @SerializeOptions({ schema: adminWalletEntryPageSchema })
  @ApiOkResponse({ description: 'Newest first', standardSchema: adminWalletEntryPageSchema })
  entries(
    @Param('customerId') customerId: string,
    @Query({ schema: walletEntryQuerySchema }) query: WalletEntryQuery,
  ) {
    return this.wallets.adminEntries(customerId, query);
  }

  @Post('wallets/:customerId/adjustments')
  @AdminRoute()
  @Sensitive()
  @ApiIdempotencyKey()
  @SerializeOptions({ schema: adjustmentSchema })
  @ApiCreatedResponse({ description: 'Written (200: a replay)', standardSchema: adjustmentSchema })
  async adjust(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('customerId') customerId: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body({ schema: createAdjustmentSchema }) body: z.output<typeof createAdjustmentSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { adjustment, created } = await this.adjustments.create(
      admin.id,
      customerId,
      idempotencyKey,
      body,
      requestMeta(request),
    );
    response.status(created ? 201 : 200);
    return adjustment;
  }

  @Post('wallet-adjustments/:id/reverse')
  @AdminRoute()
  @Sensitive()
  @ApiIdempotencyKey()
  @SerializeOptions({ schema: adjustmentSchema })
  @ApiCreatedResponse({
    description: 'The reversal (200: a replay)',
    standardSchema: adjustmentSchema,
  })
  async reverse(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body({ schema: reverseAdjustmentSchema }) body: z.output<typeof reverseAdjustmentSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { adjustment, created } = await this.adjustments.reverse(
      admin.id,
      id,
      idempotencyKey,
      body,
      requestMeta(request),
    );
    response.status(created ? 201 : 200);
    return adjustment;
  }

  @Get('ledger/summary')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: ledgerSummarySchema })
  @ApiOkResponse({ description: 'What the store owes', standardSchema: ledgerSummarySchema })
  summary() {
    return this.wallets.summary();
  }
}
