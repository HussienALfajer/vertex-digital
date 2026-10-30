import { describe, expect, it, vi } from 'vitest';
import { shownAgainTracker } from './shown-again-tracker';

describe('shownAgainTracker', () => {
  it('stays quiet on the first show', () => {
    const onShownAgain = vi.fn();
    shownAgainTracker(onShownAgain).shown();
    expect(onShownAgain).not.toHaveBeenCalled();
  });

  it('leaves the form alone while a write is unanswered', () => {
    const onShownAgain = vi.fn();
    let busy = true;
    const tracker = shownAgainTracker(onShownAgain, () => busy);
    tracker.hidden();
    tracker.shown();
    expect(onShownAgain).not.toHaveBeenCalled();
    busy = false;
    tracker.hidden();
    tracker.shown();
    expect(onShownAgain).toHaveBeenCalledTimes(1);
  });

  it('answers once per hide and show', () => {
    const onShownAgain = vi.fn();
    const tracker = shownAgainTracker(onShownAgain);
    tracker.shown();
    tracker.hidden();
    tracker.shown();
    expect(onShownAgain).toHaveBeenCalledTimes(1);
    // An effect running again with no hide in between is not a re-show.
    tracker.shown();
    expect(onShownAgain).toHaveBeenCalledTimes(1);
    tracker.hidden();
    tracker.shown();
    expect(onShownAgain).toHaveBeenCalledTimes(2);
  });
});
