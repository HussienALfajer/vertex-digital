import { catalogImagePath } from '@vertex-digital/contracts';
import Link from 'next/link';
import { CatalogPicture } from '@/features/catalog/catalog-picture';
import { t } from '@/lib/i18n';
import { BannerCarousel } from './banner-carousel';
import { siteContent } from './data';

/** Banners are stored at 1600 × 800 (S14 BN2), served at the catalog widths (S09 SF5). */
const BANNER_SIZE = { width: 1600, height: 800 };

/**
 * The home banners (S14 SL2) under the hero: the live ones by position, absent with none or when
 * the read failed. The first loads eagerly; a banner with a link is one link.
 */
export async function HomeBanners() {
  const banners = (await siteContent())?.banners ?? [];
  if (banners.length === 0) return null;
  return (
    <div className="mx-auto w-full max-w-6xl px-4 pt-6">
      <BannerCarousel
        label={t('content.banners.label')}
        dotLabels={banners.map((_, index) =>
          t('content.banners.show', { index: index + 1, count: banners.length }),
        )}
      >
        {banners.map((banner, index) => {
          const picture = (
            <CatalogPicture
              key={banner.id}
              image={{ id: banner.imageId, url: catalogImagePath(banner.imageId), ...BANNER_SIZE }}
              sizes="(min-width: 72rem) 70rem, 92vw"
              alt={banner.altText}
              priority={index === 0}
              className="aspect-[2/1] h-auto w-full"
            />
          );
          return banner.linkPath ? (
            <Link key={banner.id} href={banner.linkPath} prefetch={false} className="block">
              {picture}
            </Link>
          ) : (
            <div key={banner.id}>{picture}</div>
          );
        })}
      </BannerCarousel>
    </div>
  );
}
