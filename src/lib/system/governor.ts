/**
 * Automatic quality (phase 30). While playing, the preview is drawn at a fraction of its size when frames come out
 * slower than the project rate, and goes back up once there is headroom. Pure: it takes measured frame rates and
 * returns a scale, so it is tested without a browser.
 */

export const LEVELS = [1, 0.75, 0.5, 0.35];

export type Governor = {
  /** One measurement (about twice a second). Returns the scale to draw at. */
  sample: (m: { fps: number; target: number; playing: boolean }) => number;
  readonly scale: number;
  reset: () => void;
};

export function createGovernor(opts: { levels?: number[]; dropBelow?: number; raiseAbove?: number; dropAfter?: number; raiseAfter?: number } = {}): Governor {
  const levels = opts.levels ?? LEVELS;
  const dropBelow = opts.dropBelow ?? 0.8;
  const raiseAbove = opts.raiseAbove ?? 0.97;
  const dropAfter = opts.dropAfter ?? 2;
  const raiseAfter = opts.raiseAfter ?? 10; // slow to come back up, so quality does not flicker
  let level = 0;
  let slow = 0;
  let fast = 0;
  return {
    sample: ({ fps, target, playing }) => {
      if (!playing || target <= 0) {
        slow = fast = 0;
        return levels[level];
      }
      if (fps < target * dropBelow) {
        slow++;
        fast = 0;
        if (slow >= dropAfter && level < levels.length - 1) (level++, (slow = 0));
      } else if (fps >= target * raiseAbove) {
        fast++;
        slow = 0;
        if (fast >= raiseAfter && level > 0) (level--, (fast = 0));
      } else slow = fast = 0;
      return levels[level];
    },
    get scale() {
      return levels[level];
    },
    reset: () => ((level = 0), (slow = fast = 0)),
  };
}
