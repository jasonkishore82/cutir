import { create } from "zustand";
import { EASINGS } from "./animations";
import { uid, useProject, type Easing, type Keyframe, type KeyProp, type LyricLine, type Project } from "../store/project";

/**
 * Keyframes: custom motion on a line (position, scale, rotation, opacity).
 *
 * Each property animates on its own: it is interpolated between the keyframes that key it, using the easing of the
 * earlier one, and holds its value before the first and after the last. A property no keyframe keys stays at rest.
 * The renderer applies the result on top of the style transform and the in/out/loop animation, in preview and export.
 */

export const KEY_PROPS: KeyProp[] = ["x", "y", "scale", "rotation", "opacity"];
export type KeyValues = Record<KeyProp, number>;
export const REST_VALUES: KeyValues = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };

/** How close (seconds) the playhead must be to a keyframe to count as "on" it: half a frame at 30 fps. */
export const ON_KEY = 1 / 60;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

export const sortKeys = (kfs: Keyframe[]) => [...kfs].sort((a, b) => a.time - b.time);

/** Value of every property at `t` seconds into the line. */
export function evalKeyframes(kfs: Keyframe[] | undefined, t: number): KeyValues {
  const out = { ...REST_VALUES };
  if (!kfs?.length) return out;
  const sorted = sortKeys(kfs);
  for (const prop of KEY_PROPS) {
    const keyed = sorted.filter((k) => k.props[prop] !== undefined);
    if (!keyed.length) continue;
    if (t <= keyed[0].time) {
      out[prop] = keyed[0].props[prop]!;
      continue;
    }
    const last = keyed[keyed.length - 1];
    if (t >= last.time) {
      out[prop] = last.props[prop]!;
      continue;
    }
    const i = keyed.findIndex((k) => k.time > t);
    const a = keyed[i - 1];
    const b = keyed[i];
    const span = b.time - a.time;
    const e = EASINGS[a.easing] ?? EASINGS.linear;
    const f = span > 0 ? e(clamp01((t - a.time) / span)) : 1;
    out[prop] = a.props[prop]! + (b.props[prop]! - a.props[prop]!) * f;
  }
  return out;
}

/** Properties any keyframe of the line keys. */
export const keyedProps = (kfs: Keyframe[] | undefined): KeyProp[] => KEY_PROPS.filter((p) => kfs?.some((k) => k.props[p] !== undefined));

export const keyAt = (line: LyricLine, t: number): Keyframe | undefined => line.keyframes?.find((k) => Math.abs(k.time - t) <= ON_KEY);

/* ---------- pure edits on a line ---------- */

function withKeys(line: LyricLine, kfs: Keyframe[]): LyricLine {
  const kept = kfs.filter((k) => Object.keys(k.props).length > 0);
  if (kept.length) return { ...line, keyframes: sortKeys(kept) };
  const { keyframes: _gone, ...rest } = line;
  void _gone;
  return rest;
}

/** Key `props` at time t (merging into a keyframe already there). Returns the line and the keyframe's id. */
export function keyLineAt(line: LyricLine, t: number, props: Partial<KeyValues>, easing: Easing = "ease-in-out"): { line: LyricLine; id: string } {
  const time = round(Math.max(0, Math.min(t, line.end - line.start)), 3);
  const clean = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, round(v as number)])) as Partial<KeyValues>;
  const found = keyAt(line, time);
  if (found) {
    const kfs = line.keyframes!.map((k) => (k.id === found.id ? { ...k, props: { ...k.props, ...clean } } : k));
    return { line: withKeys(line, kfs), id: found.id };
  }
  const kf: Keyframe = { id: uid(), time, props: clean, easing };
  return { line: withKeys(line, [...(line.keyframes ?? []), kf]), id: kf.id };
}

/**
 * Split a line's keyframes at `cut` seconds into the line. The first part keeps the keyframes before the cut, the
 * second part gets the rest shifted to its own start. Both get a keyframe at the cut so the motion stays continuous.
 */
export function splitKeyframes(kfs: Keyframe[] | undefined, cut: number): [Keyframe[] | undefined, Keyframe[] | undefined] {
  if (!kfs?.length) return [undefined, undefined];
  const props = keyedProps(kfs);
  const at = evalKeyframes(kfs, cut);
  const edge = Object.fromEntries(props.map((p) => [p, round(at[p])])) as Partial<KeyValues>;
  const easingAt = sortKeys(kfs).filter((k) => k.time <= cut).pop()?.easing ?? "ease-in-out";
  const first = [...kfs.filter((k) => k.time < cut - ON_KEY), { id: uid(), time: round(cut, 3), props: edge, easing: easingAt }];
  const second = [
    { id: uid(), time: 0, props: edge, easing: easingAt },
    ...kfs.filter((k) => k.time > cut + ON_KEY).map((k) => ({ ...k, id: uid(), time: round(k.time - cut, 3) })),
  ];
  return [sortKeys(first), sortKeys(second)];
}

/** Keyframes of two lines combined into one line that starts at `start`. */
export function mergeKeyframes(a: LyricLine, b: LyricLine, start: number): Keyframe[] | undefined {
  const all = [a, b].flatMap((l) => (l.keyframes ?? []).map((k) => ({ ...k, id: uid(), time: round(k.time + l.start - start, 3) })));
  return all.length ? sortKeys(all) : undefined;
}

/* ---------- UI state (not part of the project, not undoable) ---------- */

type KeyUi = {
  /** Moving the text between keyframes adds a keyframe at the playhead. */
  autoKey: boolean;
  /** Draw the line's x / y path on the preview. */
  showPath: boolean;
  selected: { lineId: string; id: string } | null;
  clipboard: Keyframe | null;
};

export const useKeyUi = create<KeyUi>(() => ({ autoKey: false, showPath: true, selected: null, clipboard: null }));

/* ---------- edits on the project (undoable) ---------- */

const st = () => useProject.getState();
const lineOf = (p: Project, id: string) => p.lines.find((l) => l.id === id);

function mapLine(id: string, fn: (l: LyricLine) => LyricLine, key?: string) {
  st().update((p) => ({ ...p, lines: p.lines.map((l) => (l.id === id ? fn(l) : l)) }), key);
}

/** Key properties of a line at `t` seconds into it. Selects the keyframe. */
export function setKeyAt(lineId: string, t: number, props: Partial<KeyValues>, key?: string) {
  let id = "";
  mapLine(
    lineId,
    (l) => {
      const r = keyLineAt(l, t, props);
      id = r.id;
      return r.line;
    },
    key
  );
  if (id) useKeyUi.setState({ selected: { lineId, id } });
}

/**
 * Add a keyframe at the playhead holding the line's current values. It keys the properties the line already
 * animates, or position when it has none yet. Returns false when the playhead is outside the line.
 */
export function addKeyAtPlayhead(lineId: string, now: number): boolean {
  const l = lineOf(st().project, lineId);
  if (!l || now < l.start || now > l.end) return false;
  const t = now - l.start;
  const cur = evalKeyframes(l.keyframes, t);
  const props = keyedProps(l.keyframes);
  const use = props.length ? props : (["x", "y"] as KeyProp[]);
  setKeyAt(lineId, t, Object.fromEntries(use.map((p) => [p, cur[p]])));
  return true;
}

export function updateKey(lineId: string, id: string, patch: Partial<Omit<Keyframe, "id">>, key?: string) {
  mapLine(lineId, (l) => withKeys(l, (l.keyframes ?? []).map((k) => (k.id === id ? { ...k, ...patch } : k))), key);
}

/** Key or unkey one property of a keyframe. Unkeying the last property removes the keyframe. */
export function toggleKeyProp(lineId: string, id: string, prop: KeyProp, on: boolean) {
  mapLine(lineId, (l) => {
    const time = l.keyframes?.find((k) => k.id === id)?.time ?? 0;
    const value = evalKeyframes(l.keyframes, time)[prop];
    return withKeys(
      l,
      (l.keyframes ?? []).map((k) => {
        if (k.id !== id) return k;
        const props = { ...k.props };
        if (on) props[prop] = round(value);
        else delete props[prop];
        return { ...k, props };
      })
    );
  });
}

export function removeKey(lineId: string, id: string) {
  mapLine(lineId, (l) => withKeys(l, (l.keyframes ?? []).filter((k) => k.id !== id)));
  const sel = useKeyUi.getState().selected;
  if (sel?.id === id) useKeyUi.setState({ selected: null });
}

export function clearKeys(lineId: string) {
  mapLine(lineId, (l) => withKeys(l, []));
  useKeyUi.setState({ selected: null });
}

export function copyKey(lineId: string, id: string) {
  const k = lineOf(st().project, lineId)?.keyframes?.find((x) => x.id === id);
  if (k) useKeyUi.setState({ clipboard: { ...k, props: { ...k.props } } });
}

/** Paste the copied keyframe's values into a line at the playhead. */
export function pasteKey(lineId: string, now: number): boolean {
  const clip = useKeyUi.getState().clipboard;
  const l = lineOf(st().project, lineId);
  if (!clip || !l || now < l.start || now > l.end) return false;
  st().batch(() => {
    setKeyAt(lineId, now - l.start, clip.props);
    const sel = useKeyUi.getState().selected;
    if (sel) updateKey(lineId, sel.id, { easing: clip.easing });
  }); // one undo step
  return true;
}
