import { parseRichText } from '@vertex-digital/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RichText } from './rich-text';

const render = (source: string) =>
  renderToStaticMarkup(<RichText blocks={parseRichText(source).blocks} />);

describe('RichText (S14 MD5)', () => {
  it('renders the allowed nodes as elements', () => {
    const html = render(
      [
        '## الشحن',
        'نص **غامق** و*مائل*',
        'سطر ثان',
        '',
        '### تفاصيل',
        '- أول',
        '  - فرعي',
        '- [الأسئلة](/faq#q-1)',
        '',
        '3. ثالث',
        '4. رابع',
        '',
        '> اقتباس',
      ].join('\n'),
    );
    expect(html).toContain('<h2 id="section-1"');
    expect(html).toContain('<h3 id="section-2"');
    expect(html).toContain('<strong class="font-semibold">غامق</strong>');
    expect(html).toMatch(/<em [^>]*>مائل<\/em><br\/>سطر ثان/);
    expect(html).toMatch(/<ul [^>]*><li [^>]*>أول<ul [^>]*><li [^>]*>فرعي<\/li><\/ul><\/li>/);
    expect(html).toMatch(/<a href="\/faq#q-1"[^>]*>الأسئلة<\/a>/);
    expect(html).toMatch(/<ol [^>]*start="3"/);
    expect(html).toMatch(/<blockquote [^>]*><p>اقتباس<\/p><\/blockquote>/);
  });

  it('starts an ordered list at 1 without a start attribute', () => {
    expect(render('1. أول\n2. ثان')).not.toContain('start=');
  });

  it('never renders markup, images or external links from the source', () => {
    const html = render(
      '<script>alert(1)</script>\n\n![x](/a.png)\n\n[خارجي](https://example.com)\n\n<img src=x onerror=alert(1)>',
    );
    expect(html).not.toMatch(/<script|<img|href="https/);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('خارجي');
  });

  it('passes the class and other props to its root', () => {
    const html = renderToStaticMarkup(<RichText blocks={[]} className="max-w-prose" lang="ar" />);
    expect(html).toBe(
      '<div data-slot="rich-text" class="flex flex-col gap-4 text-md text-foreground max-w-prose" lang="ar"></div>',
    );
  });
});
