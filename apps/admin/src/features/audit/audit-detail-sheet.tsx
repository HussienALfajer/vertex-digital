import type { AuditEntry } from '@vertex-digital/contracts';
import {
  Sheet,
  SheetContent,
  SheetTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@vertex-digital/ui';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CopyButton } from '../../components/copy-button';
import { formatExactTime } from '../../lib/format';
import { actorLabel, fieldLabel, fieldValue } from './audit-labels';

type Changes = { before: Record<string, unknown>; after: Record<string, unknown> };

const isChanges = (details: Record<string, unknown>): details is Changes =>
  typeof details.before === 'object' &&
  details.before !== null &&
  typeof details.after === 'object' &&
  details.after !== null;

/** One audit entry in full (rule A4): labelled before and after values, IP and browser. */
export function AuditDetailSheet({
  entry,
  onClose,
}: {
  entry: AuditEntry | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Sheet open={!!entry} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-[min(28rem,100vw)] max-w-none overflow-y-auto bg-surface p-6">
        {entry && (
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-1">
              <SheetTitle className="text-xl font-bold">{t('audit.detail.title')}</SheetTitle>
              <p className="text-base font-medium">{t(`audit.actions.${entry.action}`)}</p>
            </div>
            <dl className="flex flex-col gap-4">
              <Item label={t('audit.detail.time')}>{formatExactTime(entry.occurredAt)}</Item>
              <Item label={t('audit.detail.actor')}>{actorLabel(t, entry)}</Item>
              <Item label={t('audit.detail.channel')}>{t(`audit.channels.${entry.channel}`)}</Item>
              <Item label={t('audit.detail.entity')}>
                <span className="flex flex-col gap-1">
                  {t(`audit.entityTypes.${entry.entityType}`)}
                  <span className="flex items-center gap-1">
                    <code dir="ltr" className="text-sm break-all text-muted-foreground">
                      {entry.entityId}
                    </code>
                    <CopyButton
                      value={entry.entityId}
                      label={t('audit.copyId', { id: entry.entityId })}
                    />
                  </span>
                </span>
              </Item>
              {entry.reason && <Item label={t('audit.detail.reason')}>{entry.reason}</Item>}
              <Item label={t('audit.detail.ip')}>
                <span dir="ltr">{entry.ipAddress ?? '—'}</span>
              </Item>
              <Item label={t('audit.detail.userAgent')}>
                <span dir="ltr" className="text-sm break-all">
                  {entry.userAgent ?? '—'}
                </span>
              </Item>
            </dl>
            <Details details={entry.details} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-base">{children}</dd>
    </div>
  );
}

function Details({ details }: { details: Record<string, unknown> }) {
  const { t } = useTranslation();
  if (isChanges(details)) {
    const keys = [...new Set([...Object.keys(details.before), ...Object.keys(details.after)])];
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead />
            <TableHead>{t('audit.detail.before')}</TableHead>
            <TableHead>{t('audit.detail.after')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {keys.map((key) => (
            <TableRow key={key}>
              <TableHead scope="row">{fieldLabel(t, key)}</TableHead>
              <TableCell className="break-all">
                <bdi dir="auto">{fieldValue(t, key, details.before[key])}</bdi>
              </TableCell>
              <TableCell className="break-all">
                <bdi dir="auto">{fieldValue(t, key, details.after[key])}</bdi>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }
  const keys = Object.keys(details);
  if (keys.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('audit.detail.noDetails')}</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-base font-bold">{t('audit.detail.details')}</h3>
      <dl className="flex flex-col gap-3">
        {/* `dir="auto"` keeps emails, phone numbers and amounts left to right. */}
        {keys.map((key) => (
          <Item key={key} label={fieldLabel(t, key)}>
            <bdi dir="auto" className="break-all">
              {fieldValue(t, key, details[key])}
            </bdi>
          </Item>
        ))}
      </dl>
    </div>
  );
}
