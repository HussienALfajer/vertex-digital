import { parseRichText } from '@vertex-digital/contracts';
import { describe, expect, it } from 'vitest';
import { linkTargets, unpublishedTargets } from './rich-links';

describe('linkTargets', () => {
  it('collects links from paragraphs, headings, lists and quotes, once each', () => {
    const { blocks } = parseRichText(
      [
        '## [عنوان](/a)',
        'نص [ب](/b) و**[ج](/c)**',
        '',
        '- [د](/d)',
        '  - [هـ](/e)',
        '',
        '> [و](/f) [ب](/b)',
      ].join('\n'),
    );
    expect(linkTargets(blocks)).toEqual(['/a', '/b', '/c', '/d', '/e', '/f']);
  });
});

describe('unpublishedTargets (S14 edge case 20)', () => {
  it('names the pages and the FAQ linked before they are published', () => {
    const targets = ['/terms', '/faq#q-1', '/about/', '/games/pubg', '/privacy'];
    expect(unpublishedTargets(targets, new Set(['/privacy']))).toEqual([
      '/terms',
      '/faq#q-1',
      '/about/',
    ]);
  });
});
