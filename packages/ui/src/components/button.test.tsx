import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button } from './button';

const link = (disabled: boolean) =>
  renderToStaticMarkup(
    <Button disabled={disabled} render={<a href="/print">print</a>}>
      print
    </Button>,
  );

describe('Button with a rendered link (audit A06-13)', () => {
  it('marks a disabled link and takes it out of the tab order', () => {
    const html = link(true);
    expect(html).toContain('href="/print"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('data-disabled=""');
    expect(html).toContain('tabindex="-1"');
  });

  it('leaves an enabled link as it is', () => {
    const html = link(false);
    expect(html).not.toContain('aria-disabled');
    expect(html).not.toContain('tabindex');
  });
});
