import { AnnouncementBar } from '@vertex-digital/ui/components/announcement-bar';
import { XIcon } from 'lucide-react';
import Link from 'next/link';
import { t } from '@/lib/i18n';
import { CloseAnnouncement } from './close-announcement';
import { siteContent } from './data';
import { announcementKey, DISMISSED_SCRIPT } from './dismissal';

/**
 * The announcement bar (S14 AN1, AN3, AN4) under the header on every page, after the stop and
 * frozen banners; absent when none is live or the read failed (CP2). Plain text, never markup.
 * Rendered on the server: a bar this device closed is hidden before it paints by the constant
 * script after it, and only the close button is a client part (it ships with every page).
 */
export async function SiteAnnouncement() {
  const announcement = (await siteContent())?.announcement;
  if (!announcement) return null;
  const key = announcementKey(announcement.id, announcement.revision);
  return (
    <>
      <AnnouncementBar
        data-announcement={key}
        role="region"
        aria-label={t('content.announcement.label')}
        // The script below may hide it before React hydrates.
        suppressHydrationWarning
        tone={announcement.tone}
        text={announcement.text}
        action={
          announcement.linkPath ? (
            <Link
              href={announcement.linkPath}
              prefetch={false}
              className="inline-flex min-h-11 items-center font-medium whitespace-nowrap underline underline-offset-4"
            >
              {t('content.announcement.details')}
            </Link>
          ) : undefined
        }
        close={
          <CloseAnnouncement storageKey={key} label={t('content.announcement.close')}>
            <XIcon aria-hidden="true" className="size-4" />
          </CloseAnnouncement>
        }
      />
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a constant script, no input (ADR 0015). */}
      <script dangerouslySetInnerHTML={{ __html: DISMISSED_SCRIPT }} />
    </>
  );
}
