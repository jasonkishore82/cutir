import { z } from "zod";
import { defineTool } from "./registry";
import { activeTimeline } from "../../model/convert";
import type { Clip, ProjectDoc } from "../../model/types";
import * as E from "../../timeline/engine";
import { EASE_NAMES, type Key } from "../keyframes/engine";
import { clearLane, laneKey, lanesOf, replaceLane, type LaneId } from "../keyframes/lanes";

/**
 * Clip keyframe tools (phase 18): animate any value of a timeline clip (placement, opacity, volume, effect params)
 * with keys at times relative to the clip's start. Every call is one undo step; locked tracks are never changed.
 */

const SHAPES = ["hold", "linear", "bezier", ...EASE_NAMES.filter((e) => e !== "linear")] as const;
const KeyIn = z.object({
  t: z.number().min(0).describe("seconds from the clip's start"),
  v: z.union([z.number(), z.string(), z.object({ x: z.number(), y: z.number() })]),
  ease: z.enum(SHAPES as unknown as [string, ...string[]]).optional().describe("shape of the move from this key to the next"),
});

function findClip(doc: ProjectDoc, id: string): Clip {
  const c = activeTimeline(doc).clips.find((x) => x.id === id);
  if (!c || c.fill) throw new Error(`no clip ${id} (clip ids are in the project summary)`);
  if (E.isLocked(activeTimeline(doc), c.trackId)) throw new Error(`clip ${id} is on a locked track`);
  return c;
}

/** "scale", "opacity", "blur.radius", "fx3.radius" -> a lane of the clip. */
function resolveLane(doc: ProjectDoc, c: Clip, value: string): LaneId {
  const lanes = lanesOf(c, doc);
  const v = value.trim().toLowerCase();
  const direct = lanes.find((l) => l.key === `clip:${v}` || l.key.toLowerCase() === v);
  if (direct) return direct.id;
  const [fx, param] = v.split(".");
  if (param) {
    const effect = c.effects.find((f) => f.id.toLowerCase() === fx) ?? c.effects.find((f) => f.type === fx);
    const hit = effect && lanes.find((l) => l.id.kind === "effect" && l.id.fxId === effect.id && l.id.param.toLowerCase() === param);
    if (hit) return hit.id;
  }
  throw new Error(`clip ${c.id} has no value "${value}". It can animate: ${lanes.map((l) => (l.id.kind === "clip" ? l.id.name : `${c.effects.find((f) => f.id === (l.id as { fxId: string }).fxId)?.type}.${l.id.param}`)).join(", ")}`);
}

const toKey = (k: z.infer<typeof KeyIn>): Key => {
  const shape = k.ease ?? "ease-in-out";
  if (shape === "hold" || shape === "linear" || shape === "bezier") return { t: k.t, v: k.v, mode: shape };
  return { t: k.t, v: k.v, mode: "ease", easing: shape as Key["easing"] };
};

export const keyClipTool = defineTool({
  name: "key_clip",
  group: "timeline",
  description:
    "Animate a value of a video, image or audio clip with keyframes. value: x / y (centre, 0..1 of the frame, 0.5 = middle), scale (1 = fitted), rotation (degrees, clockwise), opacity (0..1), volume (0..2), or an effect param as <effect type or id>.<param> (e.g. blur.radius). keys: times in seconds from the clip's start. replace: true drops the value's old keys first.",
  params: z.object({ clip: z.string(), value: z.string().min(1), keys: z.array(KeyIn).min(1), replace: z.boolean().default(false) }),
  applyDoc: (doc, a) => {
    const c = findClip(doc, a.clip);
    const id = resolveLane(doc, c, a.value);
    const old = a.replace ? [] : lanesOf(c, doc).find((l) => l.key === laneKey(id))?.keys ?? [];
    const added = a.keys.filter((k) => k.t <= c.duration + 1e-6).map(toKey);
    if (!added.length) throw new Error(`every key is past the clip's end (${c.duration.toFixed(2)} s)`);
    const keys = [...old.filter((k) => !added.some((n) => Math.abs(n.t - k.t) <= 0.02)), ...added];
    return { doc: E.onActive(doc, (t) => replaceLane(t, c.id, id, keys)), summary: `${a.value} of ${c.id}: ${keys.length} keyframe(s)` };
  },
});

export const clearClipKeysTool = defineTool({
  name: "clear_clip_keys",
  group: "timeline",
  description: "Remove keyframes from a clip: of one value (same names as key_clip), or of every value when value is left out.",
  params: z.object({ clip: z.string(), value: z.string().optional() }),
  applyDoc: (doc, a) => {
    const c = findClip(doc, a.clip);
    const ids = a.value ? [resolveLane(doc, c, a.value)] : lanesOf(c, doc).filter((l) => l.keys.length).map((l) => l.id);
    if (!ids.length) throw new Error(`clip ${c.id} has no keyframes`);
    return { doc: E.onActive(doc, (t) => ids.reduce((acc, id) => clearLane(acc, c.id, id), t)), summary: `keyframes cleared on ${c.id}` };
  },
});

export const clipKeyTools = [keyClipTool, clearClipKeysTool];
