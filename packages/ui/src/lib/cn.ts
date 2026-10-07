import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Teach tailwind-merge the Vertex scales that differ from Tailwind's defaults, so `text-md`
// is read as a font size (not a color) and `shadow-float` as a shadow.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['xs', 'sm', 'base', 'md', 'lg', 'xl', '2xl', '3xl', '4xl'],
      shadow: ['float'],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
