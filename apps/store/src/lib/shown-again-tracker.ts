/**
 * Tells a re-show from the first show: Next keeps a left page mounted but hidden (React Activity),
 * running its effects' cleanups on hide and the effects again on the re-show, with every state as
 * it was.
 */
export function shownAgainTracker(onShownAgain: () => void, busy: () => boolean = () => false) {
  let hidden = false;
  return {
    shown() {
      // A write still unanswered: its form stays busy until its answer navigates or refuses.
      if (hidden && !busy()) onShownAgain();
      hidden = false;
    },
    hidden() {
      hidden = true;
    },
  };
}
