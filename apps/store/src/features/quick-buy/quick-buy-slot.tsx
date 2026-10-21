'use client';

import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { readSession } from '@/lib/session';

/** The row's place while it loads: the title's and the cards' height (QB6). */
export function RowSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 pt-6" aria-hidden="true">
      <Skeleton className="h-6 w-32" />
      <div className="flex gap-3 overflow-hidden">
        {['a', 'b', 'c'].map((key) => (
          <Skeleton key={key} className="h-36 w-64 shrink-0" />
        ))}
      </div>
    </div>
  );
}

// The cards, the menu and the sheet load only for a signed-in customer (QB6).
const QuickBuyRow = dynamic(() => import('./quick-buy-row').then((module) => module.QuickBuyRow), {
  loading: () => <RowSkeleton />,
});

/**
 * The home page's slot for "اشحن مجدداً" (S22 QB6): never in the cached page; a browser whose
 * customer was signed in last time (`data-signed-in-hint`) reserves the row's height before paint,
 * so it appears without moving the page; signed out it stays empty.
 */
export function QuickBuySlot() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void readSession().then((session) => {
      if (live) setSignedIn(!!session && session.user.emailVerified !== false);
    });
    return () => {
      live = false;
    };
  }, []);
  if (signedIn === null) {
    return (
      <div className="hidden [[data-signed-in-hint]_&]:block">
        <RowSkeleton />
      </div>
    );
  }
  return signedIn ? <QuickBuyRow /> : null;
}
