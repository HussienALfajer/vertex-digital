import type { ComponentProps, ReactNode, Ref } from 'react';
import { cn } from '../lib/cn';

/** The signature motif (§5): a short sand bar at the logo's 60° angle. Decorative only. */
function AscentBar({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      aria-hidden="true"
      data-slot="ascent-bar"
      className={cn('inline-block h-6 w-1 shrink-0 -skew-x-30 bg-accent', className)}
      {...props}
    />
  );
}

interface PageHeaderProps extends Omit<ComponentProps<'header'>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  /** Page-level actions, placed at the inline end. */
  actions?: ReactNode;
  /** The heading, made focusable: where the focus goes when an action leaves the page with it. */
  headingRef?: Ref<HTMLHeadingElement>;
}

function PageHeader({
  title,
  description,
  actions,
  headingRef,
  className,
  ...props
}: PageHeaderProps) {
  return (
    <header
      data-slot="page-header"
      className={cn('flex flex-wrap items-start justify-between gap-4', className)}
      {...props}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-3">
          <AscentBar />
          {/* Names typed by users (a department, a client) can be one long word. */}
          <h1
            ref={headingRef}
            tabIndex={headingRef ? -1 : undefined}
            className="min-w-0 text-2xl font-bold text-foreground wrap-anywhere"
          >
            {title}
          </h1>
        </div>
        {description && <p className="ps-4 text-base text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}

export { AscentBar, PageHeader };
