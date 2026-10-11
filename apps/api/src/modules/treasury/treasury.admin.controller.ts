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
  createSupplierCorrectionSchema,
  createTreasuryMovementSchema,
  moneyPlacesSchema,
  reverseTreasuryMovementSchema,
  type TreasuryMovementQuery,
  treasuryMovementPageSchema,
  treasuryMovementQuerySchema,
  treasuryMovementSchema,
} from '@vertex-digital/contracts';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { AdminRoute, CurrentAdmin, Sensitive } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { ApiIdempotencyKey, IdempotencyKey } from '../../core/http/idempotency-key.js';
import { requestMeta } from '../../core/http/request-meta.js';
import type { AdminIdentity } from '../admin/index.js';
import { TreasuryService } from './treasury.service.js';

/**
 * The money places and their movements (S13). Recording and reversing need a recent
 * re-authentication and an `Idempotency-Key` (rule T7): `201` when written, `200` on a replay.
 */
@ApiTags('treasury')
@Controller('admin/treasury')
export class TreasuryAdminController {
  constructor(private readonly treasury: TreasuryService) {}

  @Get('places')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: moneyPlacesSchema })
  @ApiOkResponse({
    description: 'Each place, books and outside',
    standardSchema: moneyPlacesSchema,
  })
  places() {
    return this.treasury.places();
  }

  @Get('movements')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(treasuryMovementQuerySchema)
  @SerializeOptions({ schema: treasuryMovementPageSchema })
  @ApiOkResponse({ description: 'Newest first', standardSchema: treasuryMovementPageSchema })
  movements(@Query({ schema: treasuryMovementQuerySchema }) query: TreasuryMovementQuery) {
    return this.treasury.movements(query);
  }

  @Post('movements')
  @AdminRoute()
  @Sensitive()
  @ApiIdempotencyKey()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: treasuryMovementSchema })
  @ApiCreatedResponse({
    description: 'Written (200: a replay)',
    standardSchema: treasuryMovementSchema,
  })
  async create(
    @CurrentAdmin() admin: AdminIdentity,
    @IdempotencyKey() idempotencyKey: string,
    @Body({ schema: createTreasuryMovementSchema })
    body: z.output<typeof createTreasuryMovementSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { movement, created } = await this.treasury.create(
      admin.id,
      idempotencyKey,
      body,
      requestMeta(request),
    );
    response.status(created ? 201 : 200);
    return movement;
  }

  @Post('supplier-corrections')
  @AdminRoute()
  @Sensitive()
  @ApiIdempotencyKey()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: treasuryMovementSchema })
  @ApiCreatedResponse({
    description: 'Written (200: a replay)',
    standardSchema: treasuryMovementSchema,
  })
  async correct(
    @CurrentAdmin() admin: AdminIdentity,
    @IdempotencyKey() idempotencyKey: string,
    @Body({ schema: createSupplierCorrectionSchema })
    body: z.output<typeof createSupplierCorrectionSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { movement, created } = await this.treasury.correct(
      admin.id,
      idempotencyKey,
      body,
      requestMeta(request),
    );
    response.status(created ? 201 : 200);
    return movement;
  }

  @Post('movements/:id/reverse')
  @AdminRoute()
  @Sensitive()
  @ApiIdempotencyKey()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: treasuryMovementSchema })
  @ApiCreatedResponse({
    description: 'The reversal (200: a replay)',
    standardSchema: treasuryMovementSchema,
  })
  async reverse(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body({ schema: reverseTreasuryMovementSchema })
    body: z.output<typeof reverseTreasuryMovementSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { movement, created } = await this.treasury.reverse(
      admin.id,
      id,
      idempotencyKey,
      body,
      requestMeta(request),
    );
    response.status(created ? 201 : 200);
    return movement;
  }
}
