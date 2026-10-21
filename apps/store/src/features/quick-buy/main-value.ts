import { maskFieldValue, type SavedPlayer } from '@vertex-digital/contracts';

/** The first value of the game's current fields (else any), masked (S10 SH3). */
export function mainValue(player: SavedPlayer, masked = true): string | null {
  const key = Object.keys(player.fieldLabels).find((item) => player.fields[item]);
  const value = key ? player.fields[key] : Object.values(player.fields)[0];
  if (!value) return null;
  return masked ? maskFieldValue(value) : value;
}
