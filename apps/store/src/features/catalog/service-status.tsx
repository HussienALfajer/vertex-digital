import type { GameServiceStatus, StoreServiceState } from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui/components/badge';
import { CircleCheckIcon, CircleSlashIcon, HourglassIcon } from 'lucide-react';
import { t } from '@/lib/i18n';

/*
 * The truth signals of rules SS1 and SS2: quiet chips with an icon, never blinking
 * (brand/identity.md §6), and never naming a supplier.
 */

const GAME_STATUS = {
  normal: { tone: 'success', Icon: CircleCheckIcon },
  slow: { tone: 'warning', Icon: HourglassIcon },
  unavailable: { tone: 'neutral', Icon: CircleSlashIcon },
} as const satisfies Record<GameServiceStatus, unknown>;

/** "تعمل بشكل طبيعي" / "أبطأ من المعتاد" / "غير متوفرة حالياً" (rule SS1). */
export function GameStatusChip({ status }: { status: GameServiceStatus }) {
  const { tone, Icon } = GAME_STATUS[status];
  return (
    <Badge tone={tone}>
      <Icon aria-hidden="true" />
      {t(`catalog.status.${status}`)}
    </Badge>
  );
}

/** The home page's line (rule SS2): an `unavailable` game does not change it. */
export function ServiceLine({ service }: { service: StoreServiceState }) {
  const { tone, Icon } = GAME_STATUS[service];
  return (
    <Badge tone={tone} className="h-8 px-3 text-sm">
      <Icon aria-hidden="true" />
      {t(`catalog.service.${service}`)}
    </Badge>
  );
}
