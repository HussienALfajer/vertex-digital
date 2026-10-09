'use client';

import { Button } from '@vertex-digital/ui/components/button';
import { SearchIcon } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { t } from '@/lib/i18n';

/*
 * The ways into the search (S09 rule SR5): the header button on every page, `Ctrl+K` / `⌘K`, `/`
 * when no field has focus, and the home page's large field (rule SR6). The dialog's code and the
 * index load on the first open only, so neither weighs on the first load.
 */

const SearchDialog = dynamic(() => import('./search-dialog').then((module) => module.SearchDialog));

const OPEN_EVENT = 'vd:open-search';

/** Opens the search from anywhere on the page (the home page's field). */
export function openSearch() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

/** The header's search button; it holds the dialog for the whole page. */
export function SearchButton() {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const show = () => {
      setLoaded(true);
      setOpen(true);
    };
    const onKey = (event: KeyboardEvent) => {
      const shortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k';
      const slash = event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey;
      if (!shortcut && !(slash && !typingIn(event.target))) return;
      event.preventDefault();
      show();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_EVENT, show);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_EVENT, show);
    };
  }, []);

  return (
    <>
      <Button
        variant="ghost"
        size="xl"
        className="w-11 px-0 md:w-auto md:px-3"
        aria-label={t('search.open')}
        aria-keyshortcuts="Control+K Meta+K /"
        onClick={() => {
          setLoaded(true);
          setOpen(true);
        }}
      >
        <SearchIcon />
        <span className="hidden text-sm font-normal text-muted-foreground md:inline">
          {t('search.placeholder')}
        </span>
        <kbd
          dir="ltr"
          className="hidden rounded-sm border border-border px-1.5 font-sans text-xs font-normal text-muted-foreground md:inline"
        >
          {t('search.shortcut')}
        </kbd>
      </Button>
      {loaded && <SearchDialog open={open} onOpenChange={setOpen} />}
    </>
  );
}

/** The home page's large field (rule SR6): a button that looks like one and opens the dialog. */
export function SearchField() {
  return (
    <button
      type="button"
      onClick={openSearch}
      className="flex h-14 w-full max-w-2xl items-center gap-3 rounded-lg border border-input bg-surface px-4 text-start text-md text-muted-foreground transition-colors duration-150 hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <SearchIcon className="size-5 shrink-0" aria-hidden="true" />
      <span className="flex-1">{t('search.placeholder')}</span>
    </button>
  );
}
