import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compile } from '@tailwindcss/node';
import { describe, expect, it } from 'vitest';

const srcDir = fileURLToPath(new URL('.', import.meta.url));
const identity = readFileSync(new URL('../../../brand/identity.md', import.meta.url), 'utf8');
const theme = readFileSync(new URL('./styles/theme.css', import.meta.url), 'utf8');

/** `--color-green-50: #e8fcf8;` → { 'green-50': '#e8fcf8' } */
const themeColors = Object.fromEntries(
  [...theme.matchAll(/--color-([a-z]+-\d+):\s*(#[0-9a-f]{6});/g)].map(([, name, hex]) => [
    name,
    hex,
  ]),
);

/** Rows like "| 50 | `#E8FCF8` | `#FCF7E7` | ..." under a header naming the scales. */
function identityScale(heading: string, scales: string[]): Record<string, string> {
  const section = identity.slice(identity.indexOf(heading));
  const table = section.slice(0, section.indexOf('\n\n', section.indexOf('|')));
  const colors: Record<string, string> = {};
  for (const line of table.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    const step = cells[1];
    if (!step || !/^\d+$/.test(step)) continue;
    scales.forEach((scale, i) => {
      const hex = /#[0-9A-Fa-f]{6}/.exec(cells[i + 2] ?? '')?.[0];
      if (hex) colors[`${scale}-${step}`] = hex.toLowerCase();
    });
  }
  return colors;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

describe('design tokens', () => {
  it('match every tonal and status color in brand/identity.md', () => {
    const expected = {
      ...identityScale('### Tonal scales', ['green', 'gold', 'neutral']),
      ...identityScale('### Status colors', ['success', 'warning', 'danger', 'info']),
    };
    expect(Object.keys(expected)).toHaveLength(33 + 20);
    for (const [name, hex] of Object.entries(expected)) {
      expect(themeColors[name], name).toBe(hex);
    }
  });

  it('keep the brand colors at green-800 and gold-400', () => {
    expect(themeColors['green-800']).toBe('#004139');
    expect(themeColors['gold-400']).toBe('#b9a87a');
  });

  it('meet the contrast ratios measured in the identity', () => {
    const c = (a: string, b: string) => contrast(themeColors[a] ?? a, themeColors[b] ?? b);
    expect(c('#ffffff', 'green-800')).toBeGreaterThanOrEqual(7); // primary button, light
    expect(c('green-950', 'gold-400')).toBeGreaterThanOrEqual(7); // primary button, dark
    expect(c('neutral-900', 'neutral-50')).toBeGreaterThanOrEqual(7); // body text, light
    expect(c('neutral-600', '#ffffff')).toBeGreaterThanOrEqual(4.5); // muted text, light
    expect(c('neutral-300', 'green-900')).toBeGreaterThanOrEqual(4.5); // muted text, dark
    // Muted text on the muted surface: table heads and toggle groups (UX audit).
    expect(c('neutral-300', 'green-800')).toBeGreaterThanOrEqual(4.5); // dark
    expect(c('neutral-600', 'neutral-100')).toBeGreaterThanOrEqual(4.5); // light
    expect(c('neutral-100', 'green-800')).toBeGreaterThanOrEqual(7); // sidebar text
    expect(c('gold-700', '#ffffff')).toBeGreaterThanOrEqual(4.5); // accent as text, light
    expect(c('neutral-500', '#ffffff')).toBeGreaterThanOrEqual(3); // input border, light
    expect(c('gold-500', 'neutral-50')).toBeGreaterThanOrEqual(3); // focus ring, light
    expect(c('gold-400', 'green-800')).toBeGreaterThanOrEqual(3); // sidebar focus and marker
    // Sand on white fails: it is never used for text or icons on light surfaces.
    expect(c('gold-400', '#ffffff')).toBeLessThan(3);
  });
});

describe('generated utilities', async () => {
  const compiler = await compile('@import "tailwindcss";\n@import "./styles/index.css";', {
    base: srcDir,
    onDependency: () => {},
  });
  const build = (candidate: string) => compiler.build([candidate]);

  it('exist for brand tokens', () => {
    for (const candidate of ['bg-primary', 'bg-green-800', 'text-accent-text', 'shadow-float']) {
      expect(build(candidate), candidate).toContain(`.${candidate}`);
    }
  });

  it('follow the Vertex type scale', () => {
    expect(build('text-base')).toMatch(/--text-base:\s*0\.9375rem/);
    expect(build('text-md')).toContain('.text-md');
  });

  it('do not exist for colors, shadows and effects outside the identity', () => {
    for (const candidate of [
      'bg-blue-500',
      'text-purple-600',
      'bg-black',
      'shadow-lg',
      'drop-shadow-xl',
      'backdrop-blur-md',
      'font-mono',
      'font-serif',
      'rounded-2xl',
      'rounded-4xl',
    ]) {
      expect(build(candidate), candidate).not.toContain(`.${candidate}`);
    }
  });
});
