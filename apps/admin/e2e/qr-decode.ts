import jsQR from 'jsqr';
import { PNG } from 'pngjs';

/*
 * S22 DL5's scan check: busy covers drawn here (no game art is committed: the repository is
 * public) and a real QR decoder reading what the panel downloads.
 */

export type BusyCover = 'blocks' | 'modules' | 'stripes';

function random(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * A 1200×675 cover as busy as game art gets: saturated blocks, black and white squares the size
 * of the QR's own modules (the hardest case: they look like modules to a decoder), or stripes.
 */
export function busyCover(kind: BusyCover, seed = 7): Buffer {
  const width = 1200;
  const height = 675;
  const next = random(seed);
  const png = new PNG({ width, height });
  const cell = kind === 'modules' ? 9 : 24;
  const colors = Array.from({ length: Math.ceil(width / cell) * Math.ceil(height / cell) }, () =>
    kind === 'modules'
      ? next() < 0.5
        ? [0, 0, 0]
        : [255, 255, 255]
      : [next() * 255, next() * 255, next() * 255],
  );
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const [r = 0, g = 0, b = 0] =
        kind === 'stripes'
          ? Math.floor((x + y) / 18) % 2 === 0
            ? [12, 12, 12]
            : [240, 200, 40]
          : (colors[Math.floor(y / cell) * Math.ceil(width / cell) + Math.floor(x / cell)] ?? []);
      png.data[offset] = r;
      png.data[offset + 1] = g;
      png.data[offset + 2] = b;
      png.data[offset + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/** A PNG's size and what a QR decoder reads in it (null: no code found). */
export function decodePng(bytes: Buffer): { width: number; height: number; text: string | null } {
  const png = PNG.sync.read(bytes);
  const code = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  return { width: png.width, height: png.height, text: code?.data ?? null };
}
