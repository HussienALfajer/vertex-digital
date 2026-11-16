import { Collapsible as CollapsiblePrimitive } from '@base-ui/react/collapsible';
import { ChevronDownIcon, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { AscentLines } from '../brand/ascent-lines';
import { VertexMark } from '../brand/logo';
import { cn } from '../lib/cn';

/*
 * The sidebar of the admin panel and of the store's merchant tools (brand/identity.md §2): Vertex
 * Green with the sand mark, pages in named groups, sections that fold their pages under a guide
 * line, a sand marker and a sand icon on the active page. A link marks the active page with
 * `data-status="active"` (TanStack Router sets it itself) and a section brightens with
 * `data-current` while one of its pages is open.
 */

/** A page's link; add `sidebarItemSize` or `sidebarChildSize`. */
const sidebarLink = cn(
  'relative flex items-center rounded-md text-sidebar-muted-foreground transition-colors duration-150 ease-out',
  'hover:bg-sidebar-hover hover:text-sidebar-foreground',
  'data-[status=active]:bg-sidebar-active data-[status=active]:font-medium data-[status=active]:text-sidebar-foreground',
  '[&[data-status=active]>svg]:text-sidebar-marker',
  'before:absolute before:inset-y-2 before:start-0 before:w-0.5 before:rounded-full before:bg-sidebar-marker before:opacity-0 before:transition-opacity before:duration-150 data-[status=active]:before:opacity-100',
);

/** A section with pages under it: the active page is marked, the section only brightens. */
const sidebarSection = cn(
  'flex w-full items-center rounded-md text-start text-sidebar-muted-foreground transition-colors duration-150 ease-out select-none',
  'hover:bg-sidebar-hover hover:text-sidebar-foreground',
  'data-[current=true]:font-medium data-[current=true]:text-sidebar-foreground',
);

const sidebarItemSize = 'h-10 gap-3 px-3 text-base pointer-coarse:h-11';
/** A section's page, inside `sidebarChildren`: its marker sits on the section's guide line. */
const sidebarChildSize =
  'h-9 gap-3 px-3 text-sm pointer-coarse:h-11 before:-start-3 before:inset-y-1.5';
/** The pages under a section: a hairline from the section's icon down its pages. */
const sidebarChildren = cn(
  'relative ms-5.5 flex flex-col gap-0.5 py-0.5 ps-3',
  'after:absolute after:inset-y-1 after:start-0 after:w-px after:bg-sidebar-border',
  '[&>*]:z-10',
);

/**
 * The panel: the fixed header with the mark, the name and what the panel is, then the links,
 * scrolling under it on short screens and phones. `top` is what sits between them (the merchant's
 * name and tier).
 */
function SidebarPanel({
  title,
  subtitle,
  navLabel,
  top,
  children,
}: {
  title: string;
  subtitle?: string;
  navLabel: string;
  top?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full w-full flex-col border-e border-sidebar-border bg-sidebar text-sidebar-foreground [--ring:var(--sidebar-ring)]">
      <div className="relative flex h-16 shrink-0 items-center gap-3 overflow-hidden border-b border-sidebar-border px-4">
        {/* The 60° hairlines beside the name, never behind it (§5). */}
        <AscentLines className="absolute inset-y-0 end-0 h-full w-20 text-sidebar-border" />
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-sidebar-border bg-sidebar-active">
          <VertexMark className="w-6 text-sidebar-marker" />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-base leading-6 font-bold">{title}</span>
          {subtitle && (
            <span className="truncate text-xs leading-4 text-sidebar-muted-foreground">
              {subtitle}
            </span>
          )}
        </span>
      </div>
      {top}
      <nav
        aria-label={navLabel}
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-3 [scrollbar-width:thin]"
      >
        {children}
      </nav>
    </div>
  );
}

/** A named group of sections, its quiet heading above them; no heading for the first group. */
function SidebarGroup({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 not-first:mt-4">
      {label && (
        <p className="px-3 pb-1 text-xs font-medium text-sidebar-muted-foreground">{label}</p>
      )}
      {children}
    </div>
  );
}

/**
 * A section that folds its pages: the row opens and closes them, the chevron turns, and while it is
 * closed `closedAside` (its pages' badges) shows on the row so nothing waiting is hidden.
 */
function SidebarSection({
  icon: Icon,
  label,
  current,
  open,
  onOpenChange,
  closedAside,
  children,
}: {
  icon: LucideIcon;
  label: string;
  current: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  closedAside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <CollapsiblePrimitive.Root
      data-slot="sidebar-section"
      open={open}
      onOpenChange={onOpenChange}
      className="flex flex-col gap-0.5"
    >
      <CollapsiblePrimitive.Trigger
        data-current={current}
        className={cn(sidebarSection, sidebarItemSize, 'group')}
      >
        <Icon
          className={cn('size-5 shrink-0', current && 'text-sidebar-marker')}
          aria-hidden="true"
        />
        <span className="min-w-0 truncate">{label}</span>
        <span className="ms-auto flex items-center gap-1.5">
          {!open && closedAside}
          <ChevronDownIcon
            aria-hidden="true"
            className="size-4 shrink-0 opacity-70 transition-transform duration-200 ease-out group-data-[panel-open]:rotate-180 motion-reduce:transition-none"
          />
        </span>
      </CollapsiblePrimitive.Trigger>
      <CollapsiblePrimitive.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out data-[ending-style]:h-0 data-[starting-style]:h-0 motion-reduce:transition-none">
        <div className={sidebarChildren}>{children}</div>
      </CollapsiblePrimitive.Panel>
    </CollapsiblePrimitive.Root>
  );
}

export {
  SidebarGroup,
  SidebarPanel,
  SidebarSection,
  sidebarChildren,
  sidebarChildSize,
  sidebarItemSize,
  sidebarLink,
  sidebarSection,
};
