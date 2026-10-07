import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';
import { logoShape, markShape } from './logo-shapes';

interface SvgShape {
  viewBox: string;
  d: string;
}

type LogoProps = Omit<ComponentProps<'svg'>, 'viewBox' | 'children'> & {
  /** Accessible name. Omit only when the logo is decorative (a visible name sits next to it). */
  label?: string;
};

function BrandSvg({ shape, label, className, ...props }: LogoProps & { shape: SvgShape }) {
  const path = <path fill="currentColor" fillRule="evenodd" d={shape.d} />;
  const svgProps = {
    xmlns: 'http://www.w3.org/2000/svg',
    viewBox: shape.viewBox,
    className: cn('shrink-0', className),
    ...props,
  };
  if (!label) {
    return (
      <svg aria-hidden="true" {...svgProps}>
        {path}
      </svg>
    );
  }
  return (
    <svg role="img" aria-label={label} {...svgProps}>
      <title>{label}</title>
      {path}
    </svg>
  );
}

/**
 * Full logo (the mark over the VERTEX wordmark), in the current text color. Minimum width 96 px.
 * Colorways (§8): sand on deep green, green on white, white on green.
 */
function VertexLogo({ className, ...props }: LogoProps) {
  return <BrandSvg shape={logoShape} className={cn('w-24', className)} {...props} />;
}

/** The mark alone, in the current text color. Minimum width 24 px (§8). */
function VertexMark({ className, ...props }: LogoProps) {
  return <BrandSvg shape={markShape} className={cn('w-6', className)} {...props} />;
}

export { VertexLogo, VertexMark };
