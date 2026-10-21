import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

/*
 * Arabic text drawn by sharp's Pango with the bundled fonts (`apps/api/assets/fonts`), for the
 * images the API renders (S10 share images, S21 price lists). Every value is escaped with
 * `escapeMarkup` before it reaches the markup.
 */

const FONTS_DIR = fileURLToPath(new URL('../../../assets/fonts/', import.meta.url));
const FONT_FILES = [
  'noto-kufi-arabic-400.ttf',
  'noto-kufi-arabic-700.ttf',
  'montserrat-400.ttf',
  'montserrat-700.ttf',
].map((name) => `${FONTS_DIR}${name}`);
const FAMILY = 'Noto Kufi Arabic, Montserrat';

export const escapeMarkup = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A left-to-right value kept whole inside Arabic text (an embedding: Pango has no isolates). */
export const ltr = (text: string) => `‪${text}‬`;

/** A name kept in its own direction: left to right when its first letter is Latin. */
export const named = (text: string) =>
  /^[^\p{L}]*\p{Script=Latin}/u.test(text) ? ltr(text) : text;

let fontsLoaded: Promise<void> | null = null;

/** libvips adds each font file to fontconfig once per process: draw a character with each. */
export function loadFonts(): Promise<void> {
  fontsLoaded ??= (async () => {
    for (const fontfile of FONT_FILES) {
      await sharp({ text: { text: '.', fontfile, font: FAMILY } })
        .png()
        .toBuffer();
    }
  })();
  return fontsLoaded;
}

/** One block of text in `color` as a transparent PNG at most `width` wide. */
export async function textBlock(
  markup: string,
  size: number,
  width: number,
  options: { color: string; weight?: 400 | 700 },
) {
  const { data, info } = await sharp({
    text: {
      text: `<span foreground="${options.color}">${markup}</span>`,
      font: `${FAMILY} ${options.weight === 700 ? 'Bold ' : ''}${size}`,
      width,
      align: 'left',
      wrap: 'word-char',
      spacing: Math.round(size * 0.4),
      rgba: true,
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
