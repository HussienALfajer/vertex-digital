import type {
  CatalogMissingItem,
  CatalogStatus,
  ProductAvailability,
} from '@vertex-digital/contracts';
import { Badge, Button, Tooltip, TooltipContent, TooltipTrigger } from '@vertex-digital/ui';
import type { TFunction } from 'i18next';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../lib/api/client';
import { errorMessage } from '../../lib/errors';

/*
 * What the catalog screens share: the status chip, a product's availability (rule CT9), the move
 * buttons (rule CT5) and how a refusal reads.
 */

/** "نشطة" or "متوقفة" (rule CT4). */
export function StatusBadge({ status }: { status: CatalogStatus }) {
  const { t } = useTranslation();
  return (
    <Badge tone={status === 'active' ? 'success' : 'neutral'}>
      {t(`catalog.statuses.${status}`)}
    </Badge>
  );
}

const AVAILABILITY_TONES = {
  hidden: 'neutral',
  paused: 'neutral',
  paused_by_margin_guard: 'warning',
  out_of_stock: 'warning',
  available: 'success',
} as const satisfies Record<ProductAvailability, string>;

/** Rule CT9: until S07 maps offers, "غير متوفرة: لا مورد مرتبط". */
export function AvailabilityBadge({ availability }: { availability: ProductAvailability }) {
  const { t } = useTranslation();
  return (
    <Badge tone={AVAILABILITY_TONES[availability]}>
      {t(`catalog.availability.${availability}`)}
    </Badge>
  );
}

/** Move up or down (rule CT5): an icon button with its tooltip; a gap at either end. */
export function MoveButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  if (!onClick) return <span className="size-8" aria-hidden="true" />;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * A refused catalog change: `CATALOG_INCOMPLETE` names what the game would lack (rule CT3),
 * `CATALOG_NOT_EMPTY` the games left in the category (rule CT2); else its code's text.
 */
export function catalogFailure(t: TFunction, error: unknown): string {
  if (error instanceof ApiError && error.code === 'CATALOG_INCOMPLETE') {
    const missing = (error.details as { missing?: CatalogMissingItem[] } | undefined)?.missing;
    if (missing?.length) {
      return t('catalog.game.missing', {
        items: missing.map((item) => t(`catalog.game.missingItems.${item}`)).join('، '),
      });
    }
  }
  if (error instanceof ApiError && error.code === 'CATALOG_NOT_EMPTY') {
    const games = (error.details as { games?: { nameAr?: unknown }[] } | undefined)?.games ?? [];
    if (games.length > 0) {
      return t('catalog.categories.notEmpty', {
        games: games.map((game) => String(game.nameAr)).join('، '),
      });
    }
  }
  return errorMessage(t, error);
}
