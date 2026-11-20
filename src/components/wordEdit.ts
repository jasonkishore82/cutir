import { uid, useProject, lineWords, type Easing, type Keyframe, type KeyProp, type LyricLine, type Project, type StyleOverride, type WordOverride } from "../store/project";
import { evalKeyframes, keyedProps, ON_KEY, sortKeys, type KeyValues } from "../lib/keyframes";
import { beatSnapOn } from "../timeline/ui";
import { snapToBeat } from "../timeline/engine";

/**
 * Editing one word of a line (phase 16.5): its style override, extra transform and keyframes, all through
 * `updateWord` so each change is one undo step. Word keyframe times are relative to the line's start.
 */

export type WordTransform = { x: number; y: number; scale: number; rotation: number };
export const REST_WORD: WordTransform = { x: 0, y: 0, scale: 1, rotation: 0 };

/** The selected word with its line, or null when nothing (or a word that no longer exists) is selected. */
export function selectedWordOf(p: Project, sel: { lineId: string; index: number } | null) {
  if (!sel) return null;
  const line = p.lines.find((l) => l.id === sel.lineId);
  if (!line) return null;
  const words = lineWords(line.text);
  if (sel.index < 0 || sel.index >= words.length) return null;
  return { line, index: sel.index, text: words[sel.index], count: words.length, override: line.wordOverrides?.[sel.index] ?? ({} as WordOverride) };
}

/** A word's extra transform with rest values filled in. */
export const wordTransformOf = (o: WordOverride | undefined): WordTransform => ({ ...REST_WORD, ...o?.transform });

/* ---------- style paths ---------- */

export const getIn = (o: unknown, path: string): unknown => path.split(".").reduce<unknown>((a, k) => (a == null ? undefined : (a as Record<string, unknown>)[k]), o);

function setIn<T extends object>(o: T | undefined, path: string, value: unknown): T {
  const [head, ...rest] = path.split(".");
  const cur = (o ?? {}) as Record<string, unknown>;
  return { ...cur, [head]: rest.length ? setIn(cur[head] as object | undefined, rest.join("."), value) : value } as T;
}

function unsetIn<T extends object>(o: T | undefined, path: string): T | undefined {
  if (!o) return undefined;
  const [head, ...rest] = path.split(".");
  const cur = { ...(o as Record<string, unknown>) };
  if (rest.length) {
    const inner = unsetIn(cur[head] as object | undefined, rest.join("."));
    if (inner === undefined) delete cur[head];
    else cur[head] = inner;
  } else delete cur[head];
  return Object.keys(cur).length ? (cur as T) : undefined;
}

/** Set (or with `undefined`, remove) one field of a word's style override. */
export function writeWordStyle(lineId: string, index: number, path: string, value: unknown, key?: string) {
  const p = useProject.getState().project;
  const cur = p.lines.find((l) => l.id === lineId)?.wordOverrides?.[index]?.style;
  const style: StyleOverride | undefined = value === undefined ? unsetIn(cur, path) : setIn(cur, path, value);
  useProject.getState().updateWord(lineId, index, { style }, key);
}

/** Change part of a word's extra transform. */
export function writeWordTransform(lineId: string, index: number, patch: Partial<WordTransform>, key?: string) {
  const p = useProject.getState().project;
  const cur = p.lines.find((l) => l.id === lineId)?.wordOverrides?.[index]?.transform;
  useProject.getState().updateWord(lineId, index, { transform: { ...cur, ...patch } }, key);
}

/** Put a word back to the line: drop every override it has. */
export const resetWord = (lineId: string, index: number) =>
  useProject.getState().updateWord(lineId, index, { style: undefined, transform: undefined, keyframes: undefined, emphasis: undefined });

/* ---------- word keyframes ---------- */

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
const keysOf = (line: LyricLine, index: number) => line.wordOverrides?.[index]?.keyframes;
export const wordKeyAt = (kfs: Keyframe[] | undefined, t: number) => kfs?.find((k) => Math.abs(k.time - t) <= ON_KEY);

/** Clean, sorted keyframes, or undefined when none keep a property. */
function tidy(kfs: Keyframe[]): Keyframe[] | undefined {
  const kept = kfs.filter((k) => Object.keys(k.props).length > 0);
  return kept.length ? sortKeys(kept) : undefined;
}

function mapWordKeys(lineId: string, index: number, fn: (kfs: Keyframe[], line: LyricLine) => Keyframe[], key?: string) {
  const st = useProject.getState();
  const line = st.project.lines.find((l) => l.id === lineId);
  if (!line) return;
  st.updateWord(lineId, index, { keyframes: tidy(fn(keysOf(line, index) ?? [], line)) }, key);
}

/** Key `props` of a word at `t` seconds into its line, merging into a keyframe already there. */
export function setWordKeyAt(lineId: string, index: number, t: number, props: Partial<KeyValues>, key?: string, easing: Easing = "ease-in-out") {
  mapWordKeys(
    lineId,
    index,
    (kfs, line) => {
      const time = round(Math.max(0, Math.min(t, line.end - line.start)), 3);
      const clean = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, round(v as number)])) as Partial<KeyValues>;
      const found = wordKeyAt(kfs, time);
      if (found) return kfs.map((k) => (k.id === found.id ? { ...k, props: { ...k.props, ...clean } } : k));
      return [...kfs, { id: uid(), time, props: clean, easing }];
    },
    key
  );
}

/** Add a keyframe at `now` (absolute seconds) holding the word's current values. False when outside the line. */
export function addWordKeyAt(lineId: string, index: number, now: number): boolean {
  const line = useProject.getState().project.lines.find((l) => l.id === lineId);
  if (!line || now < line.start || now > line.end) return false;
  const kfs = keysOf(line, index);
  const cur = evalKeyframes(kfs, now - line.start);
  const props = keyedProps(kfs);
  const use = props.length ? props : (["x", "y"] as KeyProp[]);
  setWordKeyAt(lineId, index, now - line.start, Object.fromEntries(use.map((p) => [p, cur[p]])));
  return true;
}

export const updateWordKey = (lineId: string, index: number, id: string, patch: Partial<Omit<Keyframe, "id">>, key?: string) =>
  mapWordKeys(lineId, index, (kfs) => kfs.map((k) => (k.id === id ? { ...k, ...patch } : k)), key);

export const toggleWordKeyProp = (lineId: string, index: number, id: string, prop: KeyProp, on: boolean) =>
  mapWordKeys(lineId, index, (kfs) => {
    const time = kfs.find((k) => k.id === id)?.time ?? 0;
    const value = evalKeyframes(kfs, time)[prop];
    return kfs.map((k) => {
      if (k.id !== id) return k;
      const props = { ...k.props };
      if (on) props[prop] = round(value);
      else delete props[prop];
      return { ...k, props };
    });
  });

export const removeWordKey = (lineId: string, index: number, id: string) => mapWordKeys(lineId, index, (kfs) => kfs.filter((k) => k.id !== id));
export const clearWordKeys = (lineId: string, index: number) => mapWordKeys(lineId, index, () => []);

/**
 * Whether a change to this word at `now` edits its keyframes rather than its resting transform: yes when the
 * playhead is on one of its keyframes, or when auto-key is on and the playhead is inside the line.
 */
export function wordKeyTarget(line: LyricLine, index: number, now: number, autoKey: boolean): { t: number; v: KeyValues } | null {
  if (now < line.start || now > line.end) return null;
  const t = now - line.start;
  const kfs = keysOf(line, index);
  if (!wordKeyAt(kfs, t) && !autoKey) return null;
  return { t, v: evalKeyframes(kfs, t) };
}

/* ---------- beat snapping ---------- */

/** How far (seconds) a keyframe time may be from a beat to snap to it. */
export const BEAT_SNAP = 0.08;

/** A keyframe time (absolute seconds) moved onto the nearest beat when beat snapping is on. */
export function snapKeyTime(now: number): number {
  const beats = useProject.getState().project.beats;
  return beats?.length && beatSnapOn() ? snapToBeat(beats, now, BEAT_SNAP) : now;
}
