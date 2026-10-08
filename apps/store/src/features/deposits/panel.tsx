import { Card } from '@vertex-digital/ui/components/card';
import { IconTile } from '@vertex-digital/ui/components/icon-tile';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/** A deposit outcome's card: its icon, title and content. */
export function Panel({
  icon: Icon,
  tone,
  title,
  children,
}: {
  icon: LucideIcon;
  tone: 'muted' | 'success' | 'warning';
  title: string;
  children: ReactNode;
}) {
  return (
    <Card className="gap-4">
      <div className="flex items-center gap-3">
        <IconTile tone={tone}>
          <Icon />
        </IconTile>
        <h2 className="text-xl font-bold">{title}</h2>
      </div>
      {children}
    </Card>
  );
}

/** One labelled value inside a `<dl>`. */
export function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{children}</dd>
    </div>
  );
}
