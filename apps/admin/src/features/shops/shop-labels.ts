/** The shop state chip's tone (brand §2). */
export const SHOP_STATUS_TONES = {
  requested: 'info',
  active: 'success',
  suspended: 'warning',
  closed: 'neutral',
  rejected: 'danger',
} as const;

/** A shop customer's state chip. */
export const SHOP_CUSTOMER_TONES = {
  invited: 'info',
  unverified: 'warning',
  active: 'success',
  frozen: 'danger',
  archived: 'neutral',
} as const;

/** A shop order's margin chip: held until the order finishes, released, or none. */
export const MARGIN_TONES = { held: 'warning', released: 'success', none: 'neutral' } as const;
