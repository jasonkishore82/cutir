import { PointTracker, type Gray } from "./tracker";
import { PlanarTracker } from "./planar";

/**
 * One tracking job: feed it gray frames in order and it returns the followed point (or planar region). It is the part
 * that does the heavy matching, so it runs in a worker (track.worker.ts) and under node (the tests); the frames are
 * produced by the editor on the page. Positions are in pixels of the frames given.
 */

export type TrackSpec =
  | { mode: "point"; x: number; y: number; radius?: number }
  | { mode: "planar"; region: { x: number; y: number; w: number; h: number }; grid?: number; radius?: number };

export type TrackStep = { x: number; y: number; c: number; /** Planar only: degrees clockwise since the start, and size relative to the start. */ rot?: number; scale?: number };

/** An angle in degrees moved by whole turns to sit within half a turn of the previous one (no jump from 179 to -179). */
export const unwrapAngle = (last: number, rot: number) => rot + 360 * Math.round((last - rot) / 360);

export class TrackSession {
  private point: PointTracker | null = null;
  private planar: PlanarTracker | null = null;
  private lastRot = 0;
  /** The point (or region centre) at the first frame. */
  readonly start: { x: number; y: number };
  constructor(first: Gray, spec: TrackSpec) {
    if (spec.mode === "point") {
      this.point = new PointTracker(first, spec.x, spec.y, { radius: spec.radius });
      this.start = { x: spec.x, y: spec.y };
    } else {
      this.planar = new PlanarTracker(first, spec.region, { grid: spec.grid, radius: spec.radius });
      this.start = { x: spec.region.x + spec.region.w / 2, y: spec.region.y + spec.region.h / 2 };
    }
  }
  /** The sample for the first frame itself. */
  first(): TrackStep {
    return this.planar ? { ...this.start, c: 1, rot: 0, scale: 1 } : { ...this.start, c: 1 };
  }
  next(frame: Gray): TrackStep | null {
    if (this.point) return this.point.next(frame);
    const r = this.planar!.next(frame);
    if (!r) return null;
    // keep the angle continuous (no jump from 179 to -179 degrees)
    const rot = unwrapAngle(this.lastRot, r.rot);
    this.lastRot = rot;
    return { x: r.x, y: r.y, c: r.c, rot, scale: r.scale };
  }
}
