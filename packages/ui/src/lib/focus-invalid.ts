import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A failed submit takes the user to the first invalid field (launch hardening, 2026-10-14): a long
 * page that refuses to save without showing why is a dead end. Both apps' forms use it, whatever
 * holds their errors (React Hook Form or their own state): an invalid field is found in the DOM,
 * by what the design system already writes for screen readers.
 *
 * - `Field invalid` (Base UI) marks the row and its control with `data-invalid` and the control
 *   with `aria-invalid`; that covers inputs, selects, switches, checkboxes and radio groups.
 * - A control outside a `Field` (an upload button, a radio card) sets `aria-invalid` itself, or its
 *   container sets `data-invalid` and the first focusable control inside it receives the focus.
 */

/** What marks an invalid field or control. */
const INVALID = '[aria-invalid="true"], [data-invalid]';

/** What can take the focus: an enabled control in the tab order. */
const FOCUSABLE = [
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'button',
  'a[href]',
  '[tabindex]',
  '[contenteditable="true"]',
]
  .map((selector) => `${selector}:not(:disabled):not([tabindex="-1"]):not([aria-hidden="true"])`)
  .join(', ');

/** Where the user types or picks a value, preferred over the buttons beside it (remove, reveal). */
const ENTRY =
  'input:not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea, select, [role="combobox"], [contenteditable="true"]';

/**
 * The control to focus for an invalid element: itself, else inside its row the control marked
 * invalid, the first place to type or pick, or the first focusable control.
 */
function controlOf(element: Element): HTMLElement | null {
  if (element.matches(FOCUSABLE)) return element as HTMLElement;
  const row = element.closest('[data-slot="field"]') ?? element;
  const controls = Array.from(row.querySelectorAll<HTMLElement>(FOCUSABLE));
  return (
    controls.find((control) => control.getAttribute('aria-invalid') === 'true') ??
    controls.find((control) => control.matches(ENTRY)) ??
    controls[0] ??
    null
  );
}

/** Opens the closed `<details>` around an element, so its field can be seen and focused. */
function openDetails(element: Element) {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (node instanceof HTMLDetailsElement && !node.open) node.open = true;
  }
}

/**
 * Scrolls the first invalid field inside `root` into view and focuses its control. Answers whether
 * one was found. The row (label, control, error) is scrolled, centred unless it is taller than
 * most of the screen; `[data-slot="field"]` keeps a scroll margin for sticky headers (base.css).
 */
export function focusFirstInvalid(root: ParentNode): boolean {
  for (const element of Array.from(root.querySelectorAll(INVALID))) {
    const control = controlOf(element);
    if (!control) continue;
    openDetails(control);
    const row = control.closest('[data-slot="field"]') ?? element;
    const tall = row.getBoundingClientRect().height > window.innerHeight * 0.6;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    row.scrollIntoView({
      block: tall ? 'start' : 'center',
      inline: 'nearest',
      behavior: reduced ? 'auto' : 'smooth',
    });
    control.focus({ preventScroll: true });
    return true;
  }
  return false;
}

/**
 * The form's side of {@link focusFirstInvalid}: put `ref` on the `<form>` (or the element holding
 * the fields) and call `focusInvalid()` where a submit is refused, by the form's own checks or by
 * the server naming a field. The focus moves after React has rendered the errors, once per call,
 * so typing never moves it. `reveal` runs first, in the same render: the form switches to the tab,
 * step or section holding the field (state the DOM cannot open alone).
 */
export function useFocusInvalid<T extends HTMLElement = HTMLFormElement>() {
  const ref = useRef<T>(null);
  const [request, setRequest] = useState(0);

  useEffect(() => {
    if (request === 0) return;
    // A frame later, so errors set by a library after this render (React Hook Form) are shown.
    const frame = requestAnimationFrame(() => {
      if (ref.current) focusFirstInvalid(ref.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [request]);

  const focusInvalid = useCallback((reveal?: () => void) => {
    reveal?.();
    setRequest((count) => count + 1);
  }, []);

  return { ref, focusInvalid };
}
