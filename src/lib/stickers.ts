import { uid, type LyricLine, type Project, type Sticker } from "../store/project";

/**
 * Doodle stickers: small vector drawings that pop in behind a line's text. Shapes are SVG path data in a 100 x 100
 * box: `fill` is a closed shape, `line` is an open stroke drawn on top (stems, tines, arrow shafts).
 */
export type Shape = { id: string; name: string; fill?: string; line?: string };

export const SHAPES: Shape[] = [
  { id: "heart", name: "Heart", fill: "M50 90 C20 64 8 46 8 31 C8 17 19 9 31 9 C40 9 47 14 50 21 C53 14 60 9 69 9 C81 9 92 17 92 31 C92 46 80 64 50 90 Z" },
  { id: "star", name: "Star", fill: "M50 6 L61 38 L95 38 L67 58 L78 92 L50 71 L22 92 L33 58 L5 38 L39 38 Z" },
  { id: "sparkle", name: "Sparkle", fill: "M50 4 C54 34 66 46 96 50 C66 54 54 66 50 96 C46 66 34 54 4 50 C34 46 46 34 50 4 Z" },
  { id: "bolt", name: "Bolt", fill: "M58 4 L20 56 L46 56 L36 96 L82 38 L54 38 Z" },
  { id: "flame", name: "Flame", fill: "M50 4 C58 26 82 38 80 62 C78 84 62 96 50 96 C36 96 20 84 20 62 C20 48 30 40 34 30 C40 40 42 44 46 44 C48 30 46 18 50 4 Z" },
  { id: "crown", name: "Crown", fill: "M8 80 L14 30 L36 54 L50 18 L64 54 L86 30 L92 80 Z" },
  { id: "bubble", name: "Speech", fill: "M10 12 H90 V66 H48 L26 90 L30 66 H10 Z" },
  { id: "note", name: "Note", fill: "M56 74 C56 84 46 92 36 90 C26 88 22 80 26 72 C30 64 42 62 52 68 Z", line: "M54 72 L54 14 L84 26" },
  { id: "cherry", name: "Cherry", fill: "M50 36 a30 30 0 1 0 0.01 0 Z", line: "M52 36 C54 18 62 8 80 4" },
  { id: "fork", name: "Fork", fill: "M30 6 L30 36 C30 50 38 54 44 54 L44 94 L56 94 L56 54 C62 54 70 50 70 36 L70 6 L62 6 L62 32 L54 32 L54 6 L46 6 L46 32 L38 32 L38 6 Z" },
  { id: "knife", name: "Knife", fill: "M62 4 C44 14 40 38 42 62 L44 62 L44 96 L60 96 L60 4 Z" },
  { id: "arrow", name: "Arrow", line: "M6 54 C30 40 52 40 82 50 M62 28 L86 50 L60 72" },
  { id: "squiggle", name: "Squiggle", line: "M4 50 C14 20 24 20 34 50 C44 80 54 80 64 50 C74 20 84 20 96 50" },
  { id: "cross", name: "Cross", line: "M20 20 L80 80 M80 20 L20 80" },
  { id: "circle", name: "Dot", fill: "M50 10 a40 40 0 1 0 0.01 0 Z" },
];
const SHAPE = new Map(SHAPES.map((s) => [s.id, s]));

/** Words that call for a doodle (checked in order; the first match per line wins). */
const KEYWORDS: [RegExp, string][] = [
  [/\b(love|heart|baby|darling|kiss|valentine)\b/i, "heart"],
  [/\b(fire|burn\w*|flame|hot|blaze)\b/i, "flame"],
  [/\b(star\w*|shin\w*|sky|night|wish)\b/i, "star"],
  [/\b(light\w*|thunder|electric|spark\w*|shock)\b/i, "bolt"],
  [/\b(dance|dancing|music|song|sing\w*|melody|beat)\b/i, "note"],
  [/\b(king|queen|crown|royal|throne)\b/i, "crown"],
  [/\b(cherry|sweet|sugar|candy)\b/i, "cherry"],
  [/\b(eat|food|plate|hungry|dinner|taste|table)\b/i, "fork"],
  [/\b(cut|knife|blade|sharp)\b/i, "knife"],
  [/\b(talk|say|said|tell|words?|whisper|call)\b/i, "bubble"],
  [/\b(go|run|away|road|way|leave|left)\b/i, "arrow"],
  [/\b(no|stop|never|wrong|dead|die|cross)\b/i, "cross"],
  [/\b(oh|ooh|wow|magic|dream\w*|glow\w*)\b/i, "sparkle"],
];

/** Spots around the edges where a doodle sits without covering centred text. */
const SPOTS: [number, number][] = [[0.14, 0.24], [0.86, 0.24], [0.14, 0.78], [0.86, 0.78], [0.5, 0.12], [0.5, 0.9]];

const lineOf = (p: Project, id: string) => p.lines.find((l) => l.id === id);
const withLine = (p: Project, id: string, fn: (l: LyricLine) => LyricLine): Project => ({ ...p, lines: p.lines.map((l) => (l.id === id ? fn(l) : l)) });
const without = (l: LyricLine): LyricLine => {
  const copy = { ...l };
  delete copy.stickers;
  return copy;
};

export const makeSticker = (shape: string, over: Partial<Sticker> = {}): Sticker => ({
  id: uid(), shape, x: 0.85, y: 0.25, size: 0.2, rotation: 0, color: "#ffd84a", outline: false, ...over,
});

/** Add a sticker of `shape` to each of the lines; each new one takes the next free spot around the edges. */
export function addSticker(p: Project, lineIds: string[], shape: string, color = "#ffd84a"): Project {
  let out = p;
  for (const id of lineIds) {
    const l = lineOf(out, id);
    if (!l || !SHAPE.has(shape)) continue;
    const n = l.stickers?.length ?? 0;
    const [x, y] = SPOTS[n % SPOTS.length];
    out = withLine(out, id, (ln) => ({ ...ln, stickers: [...(ln.stickers ?? []), makeSticker(shape, { x, y, color, rotation: n % 2 ? 8 : -8 })] }));
  }
  return out;
}

export const updateSticker = (p: Project, lineId: string, stickerId: string, patch: Partial<Sticker>): Project =>
  withLine(p, lineId, (l) => ({ ...l, stickers: (l.stickers ?? []).map((s) => (s.id === stickerId ? { ...s, ...patch } : s)) }));

export const removeSticker = (p: Project, lineId: string, stickerId: string): Project =>
  withLine(p, lineId, (l) => {
    const stickers = (l.stickers ?? []).filter((s) => s.id !== stickerId);
    return stickers.length ? { ...l, stickers } : without(l);
  });

export const clearStickers = (p: Project, lineIds?: string[]): Project => {
  const want = lineIds?.length ? new Set(lineIds) : null;
  return { ...p, lines: p.lines.map((l) => (!l.stickers || (want && !want.has(l.id)) ? l : without(l))) };
};

/** The doodle a line's words call for, or undefined. */
export const doodleFor = (text: string): string | undefined => KEYWORDS.find(([re]) => re.test(text))?.[1];

/** Auto doodles: one sticker on every chosen line whose words match a doodle (replaces that line's stickers). */
export function autoDoodles(p: Project, lineIds?: string[]): { project: Project; added: number } {
  const want = lineIds?.length ? new Set(lineIds) : null;
  const accent = p.style.highlight?.color && p.style.highlight.color !== p.style.color ? p.style.highlight.color : "#ffd84a";
  let out = clearStickers(p, want ? [...want] : undefined);
  let added = 0;
  [...out.lines].sort((a, b) => a.start - b.start).forEach((l, i) => {
    if (want && !want.has(l.id)) return;
    const shape = doodleFor(l.text);
    if (!shape) return;
    const [x, y] = SPOTS[i % SPOTS.length];
    out = withLine(out, l.id, (ln) => ({ ...ln, stickers: [makeSticker(shape, { x, y, color: accent, rotation: i % 2 ? 9 : -9 })] }));
    added++;
  });
  return { project: out, added };
}

const backOut = (t: number) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2);

/** Draw a line's stickers (behind its text): pop in over 0.3 s, sway a little, fade over the last 0.15 s. */
export function drawStickers(ctx: CanvasRenderingContext2D, line: LyricLine, t: number, w: number, h: number) {
  if (!line.stickers?.length) return;
  const age = t - line.start;
  const left = line.end - t;
  for (let i = 0; i < line.stickers.length; i++) {
    const st = line.stickers[i];
    const shape = SHAPE.get(st.shape);
    if (!shape) continue;
    const p = Math.min(1, Math.max(0, (age - i * 0.08) / 0.3));
    if (p <= 0) continue;
    const px = st.size * Math.min(w, h);
    ctx.save();
    ctx.globalAlpha *= Math.min(1, Math.max(0, left / 0.15));
    ctx.translate(st.x * w, st.y * h);
    ctx.rotate(((st.rotation + Math.sin(age * 2.2 + i) * 2.5) * Math.PI) / 180);
    const k = (px / 100) * Math.max(0.001, backOut(p));
    ctx.scale(k, k);
    ctx.translate(-50, -50);
    ctx.fillStyle = st.color;
    ctx.strokeStyle = st.color;
    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (shape.fill) {
      const path = new Path2D(shape.fill);
      if (st.outline) ctx.stroke(path);
      else ctx.fill(path);
    }
    if (shape.line) ctx.stroke(new Path2D(shape.line));
    ctx.restore();
  }
}
