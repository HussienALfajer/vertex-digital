import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  QUICK_CODE_PATTERN,
  type QuickLinkResolve,
  type QuickLinkStats,
  type QuickLinkStatsQuery,
  quickCampaign,
} from '@vertex-digital/contracts';
import {
  type Database,
  quickLinkStats,
  recordQuickLinkOpen,
  resolveQuickCode,
  withoutQueryParameters,
} from '@vertex-digital/db';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';

/**
 * Direct buy links (S22 DL1–DL5, ADR 0037): a product's permanent code resolves to an internal
 * target only (never a URL from the request), and an open of a pack is counted once per address,
 * code and hour, after the answer is chosen so the redirect never waits on it.
 */
@Injectable()
export class QuickLinksService {
  private readonly logger = new Logger(QuickLinksService.name);

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** DL2: the target of `code`; a campaign outside the pattern is dropped silently. */
  async resolve(
    code: string,
    campaign: unknown,
    address: string | null,
  ): Promise<QuickLinkResolve> {
    const normalized = code.toUpperCase();
    const found = QUICK_CODE_PATTERN.test(normalized)
      ? await resolveQuickCode(this.db, normalized)
      : null;
    if (!found) {
      throw new CodedException(404, 'QUICK_LINK_NOT_FOUND', 'No product has this code');
    }
    if (found.productId && address) {
      recordQuickLinkOpen(this.db, {
        productId: found.productId,
        code: normalized,
        campaign: quickCampaign(campaign),
        address,
      }).catch((error: unknown) =>
        // The counter key holds the visitor's address: never the query's parameters in a log.
        this.logger.error(
          { err: withoutQueryParameters(error) },
          'A quick link open was not counted',
        ),
      );
    }
    return found.resolve;
  }

  /** DL5: the panel's counts. */
  stats(query: QuickLinkStatsQuery): Promise<QuickLinkStats> {
    return quickLinkStats(this.db, query);
  }
}
