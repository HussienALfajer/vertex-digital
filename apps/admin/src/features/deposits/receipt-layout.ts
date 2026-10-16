/**
 * The image's size and the box it fills once turned: at zoom 1 its turned width fits the frame,
 * so a quarter-turned phone screenshot reads across the frame instead of overflowing it.
 */
export function receiptLayout(frameWidth: number, ratio: number, turns: number, zoom: number) {
  const sideways = turns % 2 === 1;
  const across = frameWidth * zoom;
  const width = sideways ? across / ratio : across;
  const height = width * ratio;
  return sideways
    ? { width, height, boxWidth: height, boxHeight: width }
    : { width, height, boxWidth: width, boxHeight: height };
}
