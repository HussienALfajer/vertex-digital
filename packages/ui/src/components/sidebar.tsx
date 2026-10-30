import type * as React from 'react';
import { VertexMark } from '../brand/logo';
import { cn } from '../lib/cn';

/*
 * The sidebar of the admin panel and of the store's merchant tools (brand/identity.md §2): Vertex
 * Green with the sand mark, sections with their pages under them, a sand marker on the active page.
 * A link marks the active page with `data-status="active"` (TanStack Router sets it itself) and a
 * section brightens with `data-current` while one of its pages is open.
 */

/** A page's link; add `sidebarItemSize` or `sidebarChildSize`. */
const sidebarLink = cn(
  'relative flex items-center rounded-md text-sidebar-muted-foreground transition-colors duration-150 ease-out',
  'hover:bg-sidebar-hover hover:text-sidebar-foreground',
  'data-[status=active]:bg-sidebar-active data-[status=active]:font-medium data-[status=active]:text-sidebar-foreground',
  'before:absolute before:inset-y-2 before:start-0 before:w-0.5 before:bg-sidebar-marker before:opacity-0 data-[status=active]:before:opacity-100',
);

/** A section with pages under it: the active page is marked, the section only brightens. */
const sidebarSection = cn(
  'flex items-center rounded-md text-sidebar-muted-foreground transition-colors duration-150 ease-out',
  'hover:bg-sidebar-hover hover:text-sidebar-foreground',
  'data-[current=true]:font-medium data-[current=true]:text-sidebar-foreground',
);

const sidebarItemSize = 'h-10 gap-3 px-3 text-base pointer-coarse:h-11';
const sidebarChildSize = 'h-8 gap-3 ps-11 pe-3 text-sm pointer-coarse:h-11';

/**
 * The panel: the fixed header with the mark and the name, then the links, scrolling under it on
 * short screens and phones. `top` is what sits between them (the merchant's name and tier).
 */
function SidebarPanel({
  title,
  navLabel,
  top,
  children,
}: {
  title: string;
  navLabel: string;
  top?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full w-full flex-col border-e border-sidebar-border bg-sidebar text-sidebar-foreground [--ring:var(--sidebar-ring)]">
      <div className="flex h-16 shrink-0 items-center gap-3 border-b border-sidebar-border px-5">
        <VertexMark className="w-8 text-sidebar-marker" />
        <span className="text-lg font-bold">{title}</span>
      </div>
      {top}
      <nav aria-label={navLabel} className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-3">
        {children}
      </nav>
    </div>
  );
}

export { SidebarPanel, sidebarChildSize, sidebarItemSize, sidebarLink, sidebarSection };
