import { Controller, Get, Header, SerializeOptions } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { dashboardSchema } from '@vertex-digital/contracts';
import { AdminRoute } from '../../core/access/index.js';
import { DashboardService } from './dashboard.service.js';

/** The panel's home page (S11 rules DB1–DB9): not audited, never cached. */
@ApiTags('dashboard')
@Controller('admin/dashboard')
export class DashboardAdminController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: dashboardSchema })
  @ApiOkResponse({
    description: 'Today against yesterday, and what needs the admin',
    standardSchema: dashboardSchema,
  })
  read() {
    return this.dashboard.dashboard();
  }
}
