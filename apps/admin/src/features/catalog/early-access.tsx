import { Badge, Button } from '@vertex-digital/ui';
import { TimerIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { formatDateTime } from '../../lib/format';

/*
 * S23 OP5: a game's or a pack's early access in the panel. "وصول مبكر 24 ساعة" opens a window
 * (merchants of early-access tiers see and buy it, its followers and recent buyers are told once);
 * a running window shows its end and "إنهاء الآن". Both re-authenticate (the mutation does).
 */

/** "وصول مبكر حتى …" while a window runs; nothing otherwise. */
export function EarlyAccessBadge({ until }: { until: string | null }) {
  const { t } = useTranslation();
  if (until === null) return null;
  return (
    <Badge tone="gold">
      <TimerIcon aria-hidden="true" />
      {t('catalog.earlyAccess.until', { time: formatDateTime(until) })}
    </Badge>
  );
}

export function EarlyAccessButton({
  name,
  until,
  size,
  onSet,
}: {
  name: string;
  until: string | null;
  size?: 'sm';
  onSet: (on: boolean) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<'start' | 'end' | null>(null);
  const [pending, setPending] = useState(false);
  const running = until !== null;
  const run = async (on: boolean) => {
    setPending(true);
    try {
      await onSet(on);
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <Button
        variant={running ? 'outline' : 'ghost'}
        size={size}
        onClick={() => setOpen(running ? 'end' : 'start')}
      >
        <TimerIcon aria-hidden="true" />
        {running ? t('catalog.earlyAccess.end') : t('catalog.earlyAccess.start')}
      </Button>
      <ConfirmDialog
        open={open !== null}
        onClose={() => setOpen(null)}
        title={
          open === 'end'
            ? t('catalog.earlyAccess.endTitle', { name })
            : t('catalog.earlyAccess.startTitle', { name })
        }
        body={
          open === 'end' ? t('catalog.earlyAccess.endBody') : t('catalog.earlyAccess.startBody')
        }
        action={open === 'end' ? t('catalog.earlyAccess.end') : t('catalog.earlyAccess.start')}
        pending={pending}
        onConfirm={() => run(open === 'start')}
      />
    </>
  );
}
