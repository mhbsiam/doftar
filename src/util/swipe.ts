/** Sideways wheel travel that counts as one swipe. */
const SWIPE_DISTANCE = 80;
/** A pause this long ends the gesture. Momentum scrolling keeps it alive, so one swipe fires once. */
const SWIPE_IDLE_MS = 200;

/** Turns sideways wheel deltas into one `onSwipe` per gesture: 1 for a swipe left (next), -1 for a swipe right (previous).
 *  `onProgress` gets the travel so far, from -1 to 1, and 0 when the gesture fires or ends. */
export function swipeTracker(
  onSwipe: (dir: 1 | -1) => void,
  { distance = SWIPE_DISTANCE, onProgress }: { distance?: number; onProgress?: (p: number) => void } = {}
) {
  let travel = 0;
  let fired = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  return {
    feed(deltaX: number) {
      clearTimeout(idle);
      idle = setTimeout(() => {
        travel = 0;
        fired = false;
        onProgress?.(0);
      }, SWIPE_IDLE_MS);
      if (fired) return;
      travel += deltaX;
      if (Math.abs(travel) >= distance) {
        fired = true;
        onProgress?.(0);
        onSwipe(travel > 0 ? 1 : -1);
      } else {
        onProgress?.(travel / distance);
      }
    },
    cancel: () => clearTimeout(idle),
  };
}
