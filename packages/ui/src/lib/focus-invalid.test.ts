// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { focusFirstInvalid } from './focus-invalid';

function render(html: string) {
  document.body.innerHTML = `<form>${html}</form>`;
  return document.querySelector('form') as HTMLFormElement;
}

const scrolled: Element[] = [];

beforeEach(() => {
  scrolled.length = 0;
  Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
    scrolled.push(this);
  });
});

describe('focusFirstInvalid', () => {
  it('answers false and moves nothing when every field is valid', () => {
    const form = render(
      '<div data-slot="field"><input id="a"></div><button type="submit">save</button>',
    );
    expect(focusFirstInvalid(form)).toBe(false);
    expect(document.activeElement).toBe(document.body);
    expect(scrolled).toEqual([]);
  });

  it('focuses the first invalid control in document order and scrolls its row', () => {
    const form = render(`
      <div data-slot="field" id="name-row"><label>name</label><input id="name"></div>
      <div data-slot="field" id="number-row" data-invalid>
        <label data-invalid>number</label><input id="number" aria-invalid="true" data-invalid>
      </div>
      <div data-slot="field" data-invalid><input id="later" aria-invalid="true"></div>`);
    expect(focusFirstInvalid(form)).toBe(true);
    expect(document.activeElement?.id).toBe('number');
    expect(scrolled.map((element) => element.id)).toEqual(['number-row']);
  });

  it('focuses the control of a row marked invalid: a switch, a select trigger, a radio', () => {
    const form = render(`
      <div data-slot="field" data-invalid>
        <span>enabled</span>
        <input type="checkbox" aria-hidden="true" tabindex="-1">
        <button role="switch" id="switch"></button>
      </div>`);
    focusFirstInvalid(form);
    expect(document.activeElement?.id).toBe('switch');
  });

  it('prefers the control marked aria-invalid inside a container', () => {
    const form = render(`
      <div data-invalid>
        <button type="button" role="switch" id="switch"></button>
        <input type="file" aria-hidden="true" tabindex="-1">
        <button type="button" id="upload" aria-invalid="true"></button>
      </div>`);
    focusFirstInvalid(form);
    expect(document.activeElement?.id).toBe('upload');
  });

  it('prefers the place to type over the buttons of a row marked invalid', () => {
    const form = render(`
      <li data-invalid>
        <button type="button" id="remove">remove</button>
        <input id="label">
      </li>`);
    focusFirstInvalid(form);
    expect(document.activeElement?.id).toBe('label');
  });

  it('skips disabled and hidden controls and looks at the next invalid field', () => {
    const form = render(`
      <div data-slot="field" data-invalid><input id="off" disabled aria-invalid="true"></div>
      <div data-slot="field" data-invalid><textarea id="reason" aria-invalid="true"></textarea></div>`);
    focusFirstInvalid(form);
    expect(document.activeElement?.id).toBe('reason');
  });

  it('opens the closed details around the field first', () => {
    const form = render(`
      <details id="more"><summary>more</summary>
        <div data-slot="field" data-invalid><input id="hidden" aria-invalid="true"></div>
      </details>`);
    focusFirstInvalid(form);
    expect((document.getElementById('more') as HTMLDetailsElement).open).toBe(true);
    expect(document.activeElement?.id).toBe('hidden');
  });

  it('scrolls smoothly, or at once under reduced motion', () => {
    const form = render('<div data-slot="field" data-invalid><input aria-invalid="true"></div>');
    const scroll = vi.mocked(Element.prototype.scrollIntoView);
    const media = (reduce: boolean) =>
      vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: reduce } as MediaQueryList);

    media(false);
    focusFirstInvalid(form);
    expect(scroll).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: 'smooth' }));
    media(true);
    focusFirstInvalid(form);
    expect(scroll).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: 'auto' }));
  });

  it('only looks inside the root it is given', () => {
    render('<div data-slot="field" data-invalid><input id="inside" aria-invalid="true"></div>');
    const other = document.createElement('div');
    other.innerHTML = '<input id="outside" aria-invalid="true">';
    document.body.prepend(other);
    focusFirstInvalid(document.querySelector('form') as HTMLFormElement);
    expect(document.activeElement?.id).toBe('inside');
  });
});
