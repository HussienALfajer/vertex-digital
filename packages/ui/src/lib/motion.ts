/**
 * Enter and exit transitions for Base UI popups (brand/identity.md §7): menus and popovers take
 * 200 ms, dialogs and sheets 250 ms, both ease-out. Base UI sets the starting/ending attributes.
 */
export const popupMotion =
  'origin-(--transform-origin) transition-[opacity,scale] duration-200 ease-out data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0';

export const dialogMotion =
  'transition-[opacity,scale] duration-250 ease-out data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0';

export const overlayMotion =
  'transition-opacity duration-250 ease-out data-starting-style:opacity-0 data-ending-style:opacity-0';
