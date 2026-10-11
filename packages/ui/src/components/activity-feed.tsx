import { TimerIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../lib/cn';

/** One delivery as the app wrote it (S14 LA2): the texts come in translated. */
interface ActivityFeedItem {
  key: string;
  /** The game page; the panel's preview leaves it out. */
  href?: string;
  game: string;
  /** The pack, with "× 2" when the quantity is above 1. */
  product: string;
  /** "خلال 14 ثانية" (LA5). */
  duration: string;
  /** "منذ نحو 5 دقائق" (LA4). */
  time: string;
}

interface ActivityFeedProps extends Omit<ComponentProps<'section'>, 'title'> {
  title: ReactNode;
  items: ActivityFeedItem[];
  /** The `<details>` summary for the items after the first three. */
  moreLabel: ReactNode;
}

/** How many items show before "عرض المزيد" (S14 LA7). */
const SHOWN = 3;

/**
 * "آخر التسليمات" (S14 LA7): the first three deliveries, the others in a native `<details>`.
 * A server-compatible component with no client JavaScript; a quiet truth signal (brand §6).
 */
function ActivityFeed({ title, items, moreLabel, className, ...props }: ActivityFeedProps) {
  const shown = items.slice(0, SHOWN);
  const more = items.slice(SHOWN);
  return (
    <section
      data-slot="activity-feed"
      className={cn(
        'flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 text-surface-foreground',
        className,
      )}
      {...props}
    >
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <TimerIcon aria-hidden="true" className="size-5 text-muted-foreground" />
        {title}
      </h2>
      <ul className="flex flex-col divide-y divide-border">
        {shown.map((item) => (
          <ActivityRow key={item.key} item={item} />
        ))}
      </ul>
      {more.length > 0 && (
        <details className="group">
          <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium text-primary underline-offset-4 hover:underline">
            {moreLabel}
          </summary>
          <ul className="flex flex-col divide-y divide-border border-t border-border">
            {more.map((item) => (
              <ActivityRow key={item.key} item={item} />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function ActivityRow({ item }: { item: ActivityFeedItem }) {
  const body = (
    <>
      <span className="flex min-w-0 flex-col">
        {/* Isolated, so a Latin name ("660 UC") keeps its own order in an RTL line. */}
        <span className="truncate font-medium">
          <bdi>{item.game}</bdi>
        </span>
        <span className="truncate text-sm text-muted-foreground">
          <bdi>{item.product}</bdi>
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end text-sm">
        <span className="font-medium">{item.duration}</span>
        <span className="text-muted-foreground">{item.time}</span>
      </span>
    </>
  );
  const row = 'flex min-h-14 items-center justify-between gap-3 py-2';
  return (
    <li>
      {item.href ? (
        <a href={item.href} className={cn(row, 'rounded-sm hover:bg-muted/60')}>
          {body}
        </a>
      ) : (
        <div className={row}>{body}</div>
      )}
    </li>
  );
}

export { ActivityFeed, type ActivityFeedItem, type ActivityFeedProps };
