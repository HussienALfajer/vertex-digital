import { describe, expect, it } from 'vitest';
import { SLIDE_CONFIRM_THRESHOLD, slideConfirms, slideKey } from './slide-to-pay';

describe('slideConfirms (S09 rule BB5)', () => {
  it('confirms past 85% of the track and springs back before', () => {
    expect(SLIDE_CONFIRM_THRESHOLD).toBe(0.85);
    expect(slideConfirms(0.84)).toBe(false);
    expect(slideConfirms(0.85)).toBe(true);
    expect(slideConfirms(1)).toBe(true);
  });
});

describe('slideKey (S09 rule BB5)', () => {
  it('confirms with End', () => {
    expect(slideKey('End', 0, 'rtl')).toEqual({ progress: 1, confirm: true });
  });

  it('moves forward with the arrow along the slide, confirming at the end', () => {
    expect(slideKey('ArrowLeft', 0, 'rtl')).toEqual({ progress: 0.25, confirm: false });
    expect(slideKey('ArrowLeft', 0.75, 'rtl')).toEqual({ progress: 1, confirm: true });
    expect(slideKey('ArrowRight', 0.5, 'ltr')).toEqual({ progress: 0.75, confirm: false });
    expect(slideKey('ArrowUp', 0.75, 'ltr')).toEqual({ progress: 1, confirm: true });
  });

  it('moves back with the other arrow and Home, never below the start', () => {
    expect(slideKey('ArrowRight', 0.5, 'rtl')).toEqual({ progress: 0.25, confirm: false });
    expect(slideKey('ArrowDown', 0.1, 'rtl')).toEqual({ progress: 0, confirm: false });
    expect(slideKey('Home', 0.75, 'ltr')).toEqual({ progress: 0, confirm: false });
  });

  it('ignores other keys', () => {
    expect(slideKey('Enter', 0.5, 'rtl')).toBeNull();
  });
});
