import type { SupplierCategoryNode, SupplierCode } from '@vertex-digital/contracts';
import { ImageOffIcon } from 'lucide-react';
import { useState } from 'react';
import { categoryImageUrl } from './suppliers.queries';

/** Rule IM1: the API's WebP thumbnail, or a placeholder when there is none or it fails. */
export function Thumbnail({
  node,
  supplierCode,
  size = 'size-12',
}: {
  node: Pick<SupplierCategoryNode, 'categoryId' | 'hasImage'>;
  supplierCode: SupplierCode;
  size?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (!node.hasImage || failed) {
    return (
      <span
        className={`${size} flex shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground`}
        aria-hidden="true"
      >
        <ImageOffIcon className="size-5" />
      </span>
    );
  }
  return (
    <img
      src={categoryImageUrl(supplierCode, node.categoryId)}
      alt=""
      loading="lazy"
      className={`${size} shrink-0 rounded-md bg-muted object-cover`}
      onError={() => setFailed(true)}
    />
  );
}
