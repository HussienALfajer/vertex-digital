/**
 * The shop's logo in color (ST2), or the name's first letter on the brand color without one. A
 * plain `<img>`: the logo is the API's own small WebP, served with its cache header.
 */
export function ShopMark({
  name,
  logoUrl,
  letter,
  className = 'size-10',
}: {
  name: string;
  logoUrl: string | null;
  letter: string;
  className?: string;
}) {
  if (logoUrl) {
    return (
      // biome-ignore lint/performance/noImgElement: the API's own small logo, no optimizer route.
      <img
        src={logoUrl}
        alt={name}
        className={`${className} shrink-0 rounded-lg border border-border bg-white object-contain`}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`${className} flex shrink-0 items-center justify-center rounded-lg bg-(--shop-brand) text-lg font-bold text-white`}
    >
      {letter}
    </span>
  );
}
