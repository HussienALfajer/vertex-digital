import { describe, expect, it } from 'vitest';
import { movePinned } from './pinned-games';

describe('movePinned ("ألعابك" ordering)', () => {
  it('swaps with the neighbour and stays put at either end', () => {
    expect(movePinned(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(movePinned(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    expect(movePinned(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(movePinned(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
  });
});
