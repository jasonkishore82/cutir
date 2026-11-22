/**
 * Editing a clip's sound on the clip itself (phase 21): the gain line and the fade handles. These turn pointer
 * positions into values (and values into positions), so the drawing and the dragging agree, and so they run under node.
 */

export const MAX_CLIP_GAIN = 2;

/** Height of the gain line as a fraction of the clip's height from the top: gain 2 is the top, 1 the middle, 0 the bottom. */
export const gainToFrac = (g: number) => 1 - Math.min(MAX_CLIP_GAIN, Math.max(0, g)) / MAX_CLIP_GAIN;

/** The gain for a pointer at `frac` (0 top .. 1 bottom) of the clip's height; it snaps to 1 (unity) when close, to 0.01 steps otherwise. */
export function fracToGain(frac: number): number {
  const g = Math.min(MAX_CLIP_GAIN, Math.max(0, (1 - frac) * MAX_CLIP_GAIN));
  if (Math.abs(g - 1) < 0.04) return 1;
  return Math.round(g * 100) / 100;
}

/** A gain in decibels for display ("-6.0 dB", "-inf" at silence). */
export const gainLabel = (g: number) => (g <= 0.0005 ? "-inf dB" : `${g >= 1 ? "+" : ""}${(20 * Math.log10(g)).toFixed(1)} dB`);

/**
 * A fade length for a handle dragged to `x` pixels from the clip's left edge (a fade in) or from its right edge (a fade
 * out, pass the distance from the right edge). The two fades never cross, and a fade shorter than 0.02 s is none.
 */
export function fadeFromPx(px: number, pps: number, duration: number, otherFade: number): number {
  const s = Math.min(Math.max(0, px / pps), Math.max(0, duration - otherFade));
  return s < 0.02 ? 0 : Math.round(s * 100) / 100;
}

/** Points of the fade shape (equal power, as heard) from the clip's edge, as [x, y] fractions of the fade's box: y 0 top (full level) .. 1 bottom (silent). */
export function fadeShape(steps = 12): [number, number][] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    return [t, 1 - Math.sin(t * (Math.PI / 2))] as [number, number];
  });
}

/** The SVG path of a fade in (`dir` "in", silent at the left) or out over `w` pixels and `h` pixels of height, at (x0, 0). */
export function fadePath(dir: "in" | "out", x0: number, w: number, h: number): string {
  const pts = fadeShape().map(([t, y]) => [dir === "in" ? x0 + t * w : x0 + (1 - t) * w, y * h] as const);
  const [first, ...rest] = pts;
  return `M${first[0].toFixed(1)},${first[1].toFixed(1)}${rest.map((p) => `L${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("")}`;
}
