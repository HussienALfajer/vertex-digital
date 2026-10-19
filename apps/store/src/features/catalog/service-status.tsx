import type { GameServiceStatus } from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui/components/badge';
import { CircleSlashIcon } from 'lucide-react';
import { t } from '@/lib/i18n';

/*
 * The truth signal of rule SS1: a quiet chip with an icon, never blinking (brand/identity.md §6),
 * and never naming a supplier. Owner, 2026-10-19: the store says only what the customer can act on,
 * a game they cannot buy; a slow or normal game shows no chip, and the home page has no service
 * line (the panel keeps the supplier's health).
 */

/** "غير متوفرة حاليًا" when no pack can be bought (rule SS1); nothing otherwise. */
export function GameStatusChip({ status }: { status: GameServiceStatus }) {
  if (status !== 'unavailable') return null;
  return (
    <Badge tone="neutral">
      <CircleSlashIcon aria-hidden="true" />
      {t('catalog.status.unavailable')}
    </Badge>
  );
}
