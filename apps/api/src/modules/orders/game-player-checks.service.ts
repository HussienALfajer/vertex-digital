import { Inject, Injectable } from '@nestjs/common';
import {
  type GamePlayerCheck,
  type GamePlayerCheckState,
  unmappedFields,
  unmappedOptions,
  type updateGamePlayerCheckSchema,
} from '@vertex-digital/contracts';
import {
  type Database,
  gamePlayerChecks,
  type PlayerCheckProvider,
  playerCheckProviders,
  readAll,
  recordAudit,
} from '@vertex-digital/db';
import type { z } from 'zod';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import { type Actor, CatalogService } from '../catalog/index.js';
import { SupplierAdaptersService, SupplierLiveService } from '../suppliers/index.js';

type GamePlayerCheckInput = z.output<typeof updateGamePlayerCheckSchema>;

const invalid = (path: string, message: string) =>
  new CodedException(400, 'VALIDATION_FAILED', message, [{ path: [path], message }]);

/** The row as the API answers it. */
function toCheck(row: PlayerCheckProvider): GamePlayerCheck {
  return {
    gameId: row.gameId,
    supplierCode: row.supplierCode,
    categoryId: row.categoryId,
    fieldMap: row.fieldMap,
    optionMap: row.optionMap,
    allowedRegions: row.allowedRegions,
    enabled: row.enabled,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * S19 PC1–PC3: a game's player-check provider, its check category, how our fields fill the
 * provider's and the regions the game's packs serve. Enabling one is checked against the
 * provider's live check categories (edge case 2); each change is audited with the row before and
 * after, under the game's lock.
 */
@Injectable()
export class GamePlayerChecksService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly catalog: CatalogService,
    private readonly live: SupplierLiveService,
    private readonly adapters: SupplierAdaptersService,
  ) {}

  /** `GET /api/admin/catalog/games/:id/player-check`. */
  async get(gameId: string): Promise<GamePlayerCheckState> {
    const row = (await playerCheckProviders(this.db, [gameId])).get(gameId);
    if (row) return { check: toCheck(row) };
    await this.catalog.game(gameId);
    return { check: null };
  }

  /** `PUT /api/admin/catalog/games/:id/player-check`. */
  async set(
    actor: Actor,
    gameId: string,
    input: GamePlayerCheckInput,
  ): Promise<GamePlayerCheckState> {
    const supplier = await this.live.supplier(input.supplierCode);
    if (!this.adapters.canValidatePlayer(supplier.code)) {
      throw new CodedException(409, 'CAPABILITY_UNSUPPORTED', 'The supplier checks no player ids');
    }
    // Edge case 2: an enabled row names one of the provider's own check categories.
    const category = input.enabled
      ? (await this.live.checkCategories(supplier.code)).items.find(
          (item) => item.categoryId === input.categoryId,
        )
      : undefined;
    if (input.enabled && !category) {
      throw invalid('categoryId', 'Not a check category of this supplier');
    }
    return this.db.transaction(async (tx) => {
      await this.catalog.lockGame(tx, gameId);
      const [keys, selects, before] = await readAll(tx, [
        () => this.catalog.liveFieldKeys(tx, gameId),
        () => this.catalog.liveSelectOptions(tx, gameId),
        async () => (await playerCheckProviders(tx, [gameId])).get(gameId),
      ]);
      if (!Object.values(input.fieldMap).every((key) => keys.includes(key))) {
        throw invalid('fieldMap', 'Every mapped field must be one of the game');
      }
      if (category) {
        const theirs = new Set(category.fields.map((field) => field.key));
        if (
          !Object.keys(input.fieldMap).every((key) => theirs.has(key)) ||
          unmappedFields([...theirs], input.fieldMap).length > 0 ||
          unmappedOptions(category.fields, input.fieldMap, input.optionMap, selects).length > 0
        ) {
          throw invalid('fieldMap', "The map must fill every field of the provider's category");
        }
      }
      const values = {
        supplierId: supplier.id,
        categoryId: input.categoryId,
        fieldMap: input.fieldMap,
        optionMap: input.optionMap,
        allowedRegions: input.allowedRegions,
        enabled: input.enabled,
        adminId: actor.adminId,
      };
      await tx
        .insert(gamePlayerChecks)
        .values({ gameId, ...values })
        .onConflictDoUpdate({ target: gamePlayerChecks.gameId, set: values });
      const audited = (row: Omit<GamePlayerCheck, 'gameId' | 'updatedAt'>) => ({
        supplier: row.supplierCode,
        categoryId: row.categoryId,
        fieldMap: row.fieldMap,
        optionMap: row.optionMap,
        allowedRegions: row.allowedRegions,
        enabled: row.enabled,
      });
      await recordAudit(tx, {
        action: 'catalog_game.player_check_set',
        actorKind: 'admin',
        actorId: actor.adminId,
        channel: 'admin',
        entityType: 'catalog_game',
        entityId: gameId,
        ipAddress: actor.meta.ipAddress,
        userAgent: actor.meta.userAgent,
        details: {
          before: before ? audited(toCheck(before)) : null,
          after: audited({ ...input, supplierCode: supplier.code }),
        },
      });
      const after = (await playerCheckProviders(tx, [gameId])).get(gameId) as PlayerCheckProvider;
      return { check: toCheck(after) };
    });
  }
}
