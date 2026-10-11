import { TICKET_LIMITS } from '@vertex-digital/contracts';
import { describe, expect, it } from 'vitest';
import { addImages } from './ticket-labels';

const image = (name: string, type = 'image/png', size = 1_000) =>
  new File([new Uint8Array(size)], name, { type });

describe('addImages', () => {
  it('keeps up to 3 images and reports the rest', () => {
    const { files, refused } = addImages(
      [image('a.png')],
      [image('b.jpg', 'image/jpeg'), image('c.webp', 'image/webp'), image('d.png')],
    );
    expect(files.map((file) => file.name)).toEqual(['a.png', 'b.jpg', 'c.webp']);
    expect(refused).toEqual([{ name: 'd.png', reason: 'tooMany' }]);
  });

  it('refuses other types and images over 5 MB', () => {
    const { files, refused } = addImages(
      [],
      [
        image('doc.pdf', 'application/pdf'),
        image('big.png', 'image/png', TICKET_LIMITS.imageMaxBytes + 1),
      ],
    );
    expect(files).toEqual([]);
    expect(refused).toEqual([
      { name: 'doc.pdf', reason: 'badType' },
      { name: 'big.png', reason: 'tooLarge' },
    ]);
  });
});
