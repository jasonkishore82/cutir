import { drawFrame, ASPECT_RATIO } from "./renderer";
import type { Project } from "../store/project";

const W = 320;

/** A small JPEG of the project for the Home screen: the gradient plus the first lyric line. Null if canvas is unavailable. */
export function makeThumbnail(p: Project): string | null {
  try {
    const h = Math.round(W / ASPECT_RATIO[p.aspect]);
    const c = document.createElement("canvas");
    c.width = W;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    const first = p.lines[0];
    const t = first ? first.start + Math.min(0.6, (first.end - first.start) / 2) : 0;
    // asset backgrounds are not decoded here, so they fall back to the gradient look
    drawFrame(ctx, p, t, W, h, {});
    return c.toDataURL("image/jpeg", 0.65);
  } catch {
    return null;
  }
}
