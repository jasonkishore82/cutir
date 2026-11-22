import type { Pt } from "./masks";
import { setKey, type Key, type PathValue } from "./keyframes/engine";

/**
 * Editing a mask on the viewer (phase 22). A mask shape is edited through handles drawn over the picture: the points of
 * a polygon or bezier shape, or the centre and the four edges of a rectangle or ellipse. These functions work out where
 * the handles are and what a drag changes, in frame fractions, so the overlay and the tests agree. Pure.
 */

export type MaskShape = "ellipse" | "rectangle" | "polygon" | "bezier";
export const isPathShape = (s: string): s is "polygon" | "bezier" => s === "polygon" || s === "bezier";

export type Handle = { id: string; x: number; y: number; kind: "point" | "centre" | "edge" };

type BoxParams = { center: { x: number; y: number }; width: number; height: number };

/** Handles of a rectangle or ellipse: the centre and the middle of each edge (width and height are % of the frame). */
export function boxHandles(p: BoxParams, off: { x: number; y: number }): Handle[] {
  const cx = p.center.x + off.x, cy = p.center.y + off.y;
  const hw = p.width / 200, hh = p.height / 200;
  return [
    { id: "centre", x: cx, y: cy, kind: "centre" },
    { id: "left", x: cx - hw, y: cy, kind: "edge" },
    { id: "right", x: cx + hw, y: cy, kind: "edge" },
    { id: "top", x: cx, y: cy - hh, kind: "edge" },
    { id: "bottom", x: cx, y: cy + hh, kind: "edge" },
  ];
}

/** Handles of a polygon or bezier shape: one per point, shifted by the mask's own offset (and tracker). */
export const pathHandles = (points: Pt[], off: { x: number; y: number }): Handle[] => points.map((q, i) => ({ id: `p${i}`, x: q[0] + off.x, y: q[1] + off.y, kind: "point" }));

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** What dragging a box handle to `pos` changes (new `center`, `width` or `height`). */
export function dragBox(handle: string, pos: { x: number; y: number }, p: BoxParams, off: { x: number; y: number }): Partial<{ center: { x: number; y: number }; width: number; height: number }> {
  const cx = p.center.x + off.x, cy = p.center.y + off.y;
  const round = (v: number) => Math.round(v * 10) / 10;
  switch (handle) {
    case "centre":
      return { center: { x: clamp(pos.x - off.x, -0.5, 1.5), y: clamp(pos.y - off.y, -0.5, 1.5) } };
    case "left":
    case "right":
      return { width: round(clamp(Math.abs(pos.x - cx) * 200, 1, 200)) };
    case "top":
    case "bottom":
      return { height: round(clamp(Math.abs(pos.y - cy) * 200, 1, 200)) };
    default:
      return {};
  }
}

/** Move point `i` so it appears at `pos` (the offset is taken off, since it is added when drawing). */
export function movePoint(points: Pt[], i: number, pos: { x: number; y: number }, off: { x: number; y: number }): Pt[] {
  return points.map((q, k) => (k === i ? [clamp(pos.x - off.x, -0.5, 1.5), clamp(pos.y - off.y, -0.5, 1.5)] : q));
}

/** A new point on the outline: after the edge whose middle is nearest to it. Returns the new list and the index of the new point. */
export function insertPoint(points: Pt[], pos: { x: number; y: number }, off: { x: number; y: number }): { points: Pt[]; index: number } {
  const p: Pt = [pos.x - off.x, pos.y - off.y];
  let best = 0;
  let bd = Infinity;
  points.forEach((a, i) => {
    const b = points[(i + 1) % points.length];
    const d = Math.hypot((a[0] + b[0]) / 2 - p[0], (a[1] + b[1]) / 2 - p[1]);
    if (d < bd) (bd = d), (best = i);
  });
  return { points: [...points.slice(0, best + 1), p, ...points.slice(best + 1)], index: best + 1 };
}

/** Remove a point; a shape keeps at least three. */
export const removePoint = (points: Pt[], i: number): Pt[] => (points.length > 3 ? points.filter((_, k) => k !== i) : points);

/** The handle within `radius` of a position (the nearest), or null. */
export function hitHandle(handles: Handle[], pos: { x: number; y: number }, radius: number): Handle | null {
  let best: Handle | null = null;
  let d = radius;
  for (const h of handles) {
    const e = Math.hypot(h.x - pos.x, h.y - pos.y);
    if (e <= d) (d = e), (best = h);
  }
  return best;
}

/**
 * Keyframing a shape point by point: with keys, an edit at clip time `t` writes the whole outline as a key there;
 * the keys blend point by point (see the keyframe engine's "path" kind). Keys with a different number of points
 * cannot blend, so adding or removing a point drops the other keys and keeps only the new outline.
 */
export function pathKeysAfterEdit(keys: Key[] | undefined, t: number, points: PathValue, countChanged: boolean): Key[] {
  if (countChanged) return setKey(undefined, t, points, { mode: "ease", easing: "ease-in-out" });
  return setKey(keys, t, points, { mode: "ease", easing: "ease-in-out" });
}
