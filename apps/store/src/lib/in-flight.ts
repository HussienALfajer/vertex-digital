/*
 * The money and ticket writes this tab has not had an answer to, and the work that leads from an
 * answer to its navigation. While one runs, a form must stay as it is, busy: mounting it afresh
 * (`FreshOnShow`) would offer a new press with a new key once the first answer freed the old one.
 */

let inFlight = 0;

/** `work`, counted until it settles. */
export async function trackFlight<Result>(work: Promise<Result>): Promise<Result> {
  inFlight += 1;
  try {
    return await work;
  } finally {
    inFlight -= 1;
  }
}

export const anyInFlight = (): boolean => inFlight > 0;
