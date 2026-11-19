import { uid, type LyricLine } from "../store/project";

const round2 = (n: number) => Math.round(n * 100) / 100;
const LAST_LINE_LEN = 4;

/** [mm:ss.xx] / [mm:ss] / [m:ss.xxx]; a line may carry several timestamps. */
export function parseLrc(text: string): LyricLine[] {
  const stamps: { start: number; text: string }[] = [];
  const tag = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

  for (const raw of text.split(/\r?\n/)) {
    const times: number[] = [];
    let m: RegExpExecArray | null;
    tag.lastIndex = 0;
    let lastIdx = 0;
    while ((m = tag.exec(raw))) {
      const frac = m[3] ? Number("0." + m[3]) : 0;
      times.push(Number(m[1]) * 60 + Number(m[2]) + frac);
      lastIdx = tag.lastIndex;
    }
    if (!times.length) continue; // metadata like [ar:Artist] or blank lines
    const lyric = raw.slice(lastIdx).replace(/<\d+:\d+(?:\.\d+)?>/g, "").trim(); // drop enhanced word tags
    if (!lyric) continue;
    for (const t of times) stamps.push({ start: t, text: lyric });
  }

  stamps.sort((a, b) => a.start - b.start);
  return stamps.map((s, i) => ({
    id: uid(),
    text: s.text,
    start: round2(s.start),
    end: round2(i + 1 < stamps.length ? stamps[i + 1].start : s.start + LAST_LINE_LEN),
  }));
}

function srtTime(s: string): number {
  const m = /(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(s);
  if (!m) return NaN;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number("0." + m[4]);
}

export function parseSrt(text: string): LyricLine[] {
  const out: LyricLine[] = [];
  for (const block of text.replace(/\r/g, "").split(/\n{2,}/)) {
    const rows = block.split("\n").filter((r) => r.trim() !== "");
    const ti = rows.findIndex((r) => r.includes("-->"));
    if (ti < 0) continue;
    const [a, b] = rows[ti].split("-->");
    const start = srtTime(a);
    const end = srtTime(b);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    const lyric = rows
      .slice(ti + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (lyric) out.push({ id: uid(), text: lyric, start: round2(start), end: round2(end) });
  }
  return out.sort((a, b) => a.start - b.start);
}

export function parseSubtitleFile(name: string, text: string): LyricLine[] {
  return /\.srt$/i.test(name) ? parseSrt(text) : parseLrc(text);
}

/* ---------- export: .srt and .ass (karaoke) ---------- */

import { wrapText } from "./renderer";
import { effectiveStyle, layerIdOf, resolveLayerStyle, type Project, type TextStyle } from "../store/project";

const p2 = (n: number, w = 2) => String(n).padStart(w, "0");

function srtStamp(t: number) {
  const ms = Math.round(t * 1000);
  return `${p2(Math.floor(ms / 3600000))}:${p2(Math.floor(ms / 60000) % 60)}:${p2(Math.floor(ms / 1000) % 60)},${p2(ms % 1000, 3)}`;
}

/** Hidden layers are left out. Lines from all visible layers are merged in time order. */
export function toSrt(p: Project): string {
  const visible = new Set(p.layers.filter((l) => l.visible).map((l) => l.id));
  return (
    p.lines
      .filter((l) => visible.has(layerIdOf(p, l)))
      .sort((a, b) => a.start - b.start)
      .map((l, i) => `${i + 1}\n${srtStamp(l.start)} --> ${srtStamp(l.end)}\n${effectiveStyle(p, l).uppercase ? l.text.toUpperCase() : l.text}`)
      .join("\n\n") + "\n"
  );
}

function assStamp(t: number) {
  const cs = Math.round(t * 100);
  return `${Math.floor(cs / 360000)}:${p2(Math.floor(cs / 6000) % 60)}:${p2(Math.floor(cs / 100) % 60)}.${p2(cs % 100)}`;
}

/** #rrggbb -> ASS &HAABBGGRR (alpha 00 = opaque) */
function assColor(hex: string, alpha = 0) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(h)) h = "ffffff";
  const [r, g, b] = [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)];
  return `&H${alpha.toString(16).padStart(2, "0")}${b}${g}${r}`.toUpperCase();
}

export function toAss(p: Project): string {
  const dims = { "16:9": [1920, 1080], "9:16": [1080, 1920], "1:1": [1080, 1080] }[p.aspect];
  const [W, H] = dims;
  const k = Math.min(W, H) / 1080;

  // one ASS style per layer (the project style with that layer's overrides on top)
  const styleLine = (name: string, s: TextStyle) => {
    const align = s.position === "top" ? 8 : s.position === "bottom" ? 2 : 5;
    const marginV = s.position === "center" ? 0 : Math.round(110 * k);
    const outline = Math.max(0, s.outline.width * k);
    const shadow = s.shadow.opacity > 0 ? Math.abs(s.shadow.offsetY) * k : 0;
    // Primary = already sung (full colour), Secondary = not yet sung (dimmed): karaoke fills left to right
    return `Style: ${name},${s.fontFamily},${Math.round(s.fontSize * k)},${assColor(s.color)},${assColor(s.color, 0x90)},${assColor(s.outline.color)},${assColor("#000000", 0x73)},0,0,0,0,100,100,${s.letterSpacing * k},0,1,${outline.toFixed(1)},${shadow.toFixed(1)},${align},40,40,${marginV},1`;
  };

  const head = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...p.layers.map((layer, i) => styleLine(`L${i}`, resolveLayerStyle(p, layer))),
    "",
    "[Events]",
    "Format: Layer, Start, End, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const layerIndex = new Map(p.layers.map((l, i) => [l.id, i]));
  const events = p.lines
    .filter((l) => p.layers[layerIndex.get(layerIdOf(p, l)) ?? 0].visible)
    .sort((a, b) => a.start - b.start)
    .map((l) => {
      const s = effectiveStyle(p, l);
      const li = layerIndex.get(layerIdOf(p, l)) ?? 0;
      const text = s.uppercase ? l.text.toUpperCase() : l.text;
      const rows = wrapText(text, s.maxCharsPerLine);
      const flat = rows.flatMap((r) => r.split(" "));
      const dur = Math.max(0.01, l.end - l.start);
      // real word timings when present, otherwise an even split across the line
      const times =
        l.words && l.words.length === flat.length
          ? l.words.map((w) => Math.max(0, w.end - w.start))
          : flat.map(() => dur / flat.length);
      let wi = 0;
      const body = rows
        .map((r) =>
          r
            .split(" ")
            .map((word) => `{\\k${Math.max(1, Math.round(times[wi++] * 100))}}${word}`)
            .join(" ")
        )
        .join("\\N");
      // a line placed freely on the canvas keeps its position, size and rotation in ASS
      const tf = s.transform;
      const place = tf && tf.x !== undefined && tf.y !== undefined
        ? `{\\an5\\pos(${Math.round(tf.x * W)},${Math.round(tf.y * H)})\\frz${-Math.round(tf.rotation * 10) / 10}\\fscx${Math.round(tf.scale * 100)}\\fscy${Math.round(tf.scale * 100)}}`
        : "";
      return `Dialogue: ${li},${assStamp(l.start)},${assStamp(l.end)},L${li},,0,0,0,,${place}${body}`;
    });

  return [...head, ...events, ""].join("\n");
}
