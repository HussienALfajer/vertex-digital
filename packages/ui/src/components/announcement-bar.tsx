import { cva, type VariantProps } from 'class-variance-authority';
import { InfoIcon, TriangleAlertIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../lib/cn';

const announcementBarVariants = cva('w-full', {
  variants: {
    tone: {
      info: 'bg-status-info text-status-info-foreground',
      warning: 'bg-status-warning text-status-warning-foreground',
    },
  },
  defaultVariants: { tone: 'info' },
});

interface AnnouncementBarProps
  extends ComponentProps<'div'>,
    VariantProps<typeof announcementBarVariants> {
  /** The plain text (S14 AN1): rendered as text, never as markup or links. */
  text: string;
  /** "التفاصيل" as the app's link, when the announcement has one. */
  action?: ReactNode;
  /** The close button, from the app that remembers the dismissal (AN4). */
  close?: ReactNode;
}

/**
 * The store's announcement bar under the header (S14 AN1, AN3) in a callout tone; the panel's
 * preview renders the same bar. Server-compatible: the close button comes in from the app.
 */
function AnnouncementBar({ tone, text, action, close, className, ...props }: AnnouncementBarProps) {
  const Icon = tone === 'warning' ? TriangleAlertIcon : InfoIcon;
  return (
    <div
      data-slot="announcement-bar"
      className={cn(announcementBarVariants({ tone }), className)}
      {...props}
    >
      <div className="mx-auto flex max-w-6xl items-center gap-2 ps-4 pe-1 text-sm">
        <Icon aria-hidden="true" className="size-4 shrink-0" />
        <p className="line-clamp-2 min-w-0 flex-1 py-3">{text}</p>
        {/* Outside the clamped text, so a long text never hides the link. */}
        {action && <span className="shrink-0">{action}</span>}
        {close}
      </div>
    </div>
  );
}

export { AnnouncementBar, type AnnouncementBarProps };
