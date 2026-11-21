/**
 * Captions and subtitles (phase 25): one cue model and readers and writers for SRT, WebVTT, LRC, ASS and iTT (TTML).
 * Pure text in, text out. Times are seconds, rounded to milliseconds. Timing survives a write and a read in every format.
 */

export type CueWord = { text: string; start: number; end: number };
export type Cue = {
  start: number;
  end: number;
  /** Line breaks are "\n". */
  text: string;
  words?: CueWord[];
  speaker?: string;
};

export type CueFormat = "srt" | "vtt" | "lrc" | "ass" | "itt";
export const CUE_FORMATS: { id: CueFormat; label: string; ext: string; mime: string }[] = [
  { id: "srt", label: "SubRip (.srt)", ext: "srt", mime: "application/x-subrip" },
  { id: "vtt", label: "WebVTT (.vtt)", ext: "vtt", mime: "text/vtt" },
  { id: "lrc", label: "Lyrics (.lrc)", ext: "lrc", mime: "text/plain" },
  { id: "ass", label: "Advanced SubStation (.ass)", ext: "ass", mime: "text/plain" },
  { id: "itt", label: "iTunes Timed Text (.itt)", ext: "itt", mime: "application/xml" },
];

/** ISO 639-2 codes, which is what MP4 files store for a track's language. */
const ISO3: Record<string, string> = { en: "eng", es: "spa", fr: "fra", de: "deu", it: "ita", pt: "por", nl: "nld", sv: "swe", pl: "pol", tr: "tur", ru: "rus", uk: "ukr", ar: "ara", hi: "hin", bn: "ben", ta: "tam", id: "ind", vi: "vie", th: "tha", ja: "jpn", ko: "kor", zh: "zho" };
export const iso3 = (code: string | undefined) => (code && ISO3[code.toLowerCase().slice(0, 2)]) || "und";

const ms = (n: number) => Math.round(n * 1000) / 1000;
const p2 = (n: number, w = 2) => String(Math.trunc(n)).padStart(w, "0");

/** hh:mm:ss<sep>mmm */
export function clock(t: number, sep: "," | "."): string {
  const total = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(total / 3600000);
  const m = Math.floor(total / 60000) % 60;
  const s = Math.floor(total / 1000) % 60;
  return `${p2(h)}:${p2(m)}:${p2(s)}${sep}${p2(total % 1000, 3)}`;
}

/** Clock times in any of the forms the formats use: h:mm:ss.mmm, mm:ss.mmm, h:mm:ss:ff (frames), 12.5s, 250ms. */
export function parseClock(raw: string, fps = 30): number | null {
  const s = raw.trim();
  let m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(s);
  if (m) return ms(Number(m[1]) * { ms: 0.001, s: 1, m: 60, h: 3600 }[m[2] as "ms" | "s" | "m" | "h"]);
  m = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(s);
  if (m) return ms(Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number("0." + m[4]) : 0));
  m = /^(\d+):(\d{2}):(\d{2})[:;](\d{2})$/.exec(s);
  if (m) return ms(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / fps);
  m = /^\d+(?:\.\d+)?$/.exec(s);
  return m ? ms(Number(s)) : null;
}

const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, e: string) => {
    const k = e.toLowerCase();
    if (k === "amp") return "&";
    if (k === "lt") return "<";
    if (k === "gt") return ">";
    if (k === "quot") return '"';
    if (k === "apos") return "'";
    if (k === "nbsp") return " ";
    return String.fromCodePoint(k[1] === "x" ? parseInt(k.slice(2), 16) : Number(k.slice(1)));
  });
const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const tidyText = (s: string) => s.split("\n").map((r) => r.trim()).filter(Boolean).join("\n");
const sortCues = (c: Cue[]) => c.sort((a, b) => a.start - b.start || a.end - b.end);

/* ---------- SRT ---------- */

export function parseSrt(text: string): Cue[] {
  const out: Cue[] = [];
  for (const block of text.replace(/^﻿/, "").replace(/\r/g, "").split(/\n{2,}/)) {
    const rows = block.split("\n");
    const ti = rows.findIndex((r) => r.includes("-->"));
    if (ti < 0) continue;
    const [a, b] = rows[ti].split("-->");
    const start = parseClock(a);
    const end = parseClock(b.trim().split(/\s+/)[0]);
    if (start === null || end === null) continue;
    const body = tidyText(decode(rows.slice(ti + 1).join("\n").replace(/\{\\[^}]*\}/g, "").replace(/<[^>]+>/g, "")));
    if (body) out.push({ start, end, text: body });
  }
  return sortCues(out);
}
export const toSrtText = (cues: Cue[]) => cues.map((c, i) => `${i + 1}\n${clock(c.start, ",")} --> ${clock(c.end, ",")}\n${c.text}`).join("\n\n") + "\n";

/* ---------- WebVTT ---------- */

export function parseVtt(text: string): Cue[] {
  const out: Cue[] = [];
  for (const block of text.replace(/^﻿/, "").replace(/\r/g, "").split(/\n{2,}/)) {
    const rows = block.split("\n");
    if (/^(WEBVTT|NOTE|STYLE|REGION)\b/.test(rows[0])) continue;
    const ti = rows.findIndex((r) => r.includes("-->"));
    if (ti < 0) continue;
    const [a, rest] = rows[ti].split("-->");
    const start = parseClock(a);
    const end = parseClock(rest.trim().split(/\s+/)[0]);
    if (start === null || end === null) continue;
    const raw = rows.slice(ti + 1).join("\n");
    const speaker = /<v(?:\.[^\s>]*)?\s+([^>]+)>/.exec(raw)?.[1]?.trim();
    // inline timestamps <00:01.500> make word timings (each word runs to the next stamp)
    const words: CueWord[] = [];
    const stamped = raw.replace(/<v[^>]*>/g, "").replace(/<\/?(?:c|i|b|u|ruby|rt|lang|v)[^>]*>/g, "");
    if (/<\d+:\d{2}(?::\d{2})?\.\d{3}>/.test(stamped)) {
      const parts = stamped.split(/<(\d+:\d{2}(?::\d{2})?\.\d{3})>/);
      let t = start;
      for (let i = 0; i < parts.length; i += 2) {
        const w = decode(parts[i].replace(/<[^>]+>/g, "")).trim();
        const next = i + 1 < parts.length ? parseClock(parts[i + 1]) ?? end : end;
        for (const word of w.split(/\s+/).filter(Boolean)) words.push({ text: word, start: t, end: next });
        t = next;
      }
    }
    const body = tidyText(decode(raw.replace(/<[^>]+>/g, "")));
    if (body) out.push({ start, end, text: body, ...(speaker ? { speaker } : {}), ...(words.length ? { words: spreadWords(words) } : {}) });
  }
  return sortCues(out);
}

/** Words that share one stamp (a phrase) are spread evenly across it. */
function spreadWords(words: CueWord[]): CueWord[] {
  const out: CueWord[] = [];
  for (let i = 0; i < words.length; ) {
    let j = i;
    while (j < words.length && words[j].start === words[i].start && words[j].end === words[i].end) j++;
    const n = j - i;
    const a = words[i].start;
    const len = words[i].end - a;
    for (let k = 0; k < n; k++) out.push({ text: words[i + k].text, start: ms(a + (len * k) / n), end: ms(a + (len * (k + 1)) / n) });
    i = j;
  }
  return out;
}
export function toVttText(cues: Cue[]): string {
  const body = cues.map((c) => `${clock(c.start, ".")} --> ${clock(c.end, ".")}\n${c.speaker ? `<v ${escapeXml(c.speaker)}>` : ""}${escapeXml(c.text)}`).join("\n\n");
  return `WEBVTT\n\n${body}${body ? "\n" : ""}`;
}

/* ---------- LRC ---------- */

const lrcStamp = (t: number) => {
  const cs = Math.round(t * 100);
  return `${p2(Math.floor(cs / 6000))}:${p2(Math.floor(cs / 100) % 60)}.${p2(cs % 100)}`;
};
const LRC_TAG = /^\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/;
/** [mm:ss.xx]text, several stamps per line allowed, <mm:ss.xx> word tags give word timings, an empty stamp ends the line before. */
export function parseLrc(text: string): Cue[] {
  const stamps: { t: number; text: string; words?: CueWord[] }[] = [];
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const times: number[] = [];
    let rest = raw.trim();
    for (let m = LRC_TAG.exec(rest); m; m = LRC_TAG.exec(rest)) {
      times.push(Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number("0." + m[3]) : 0));
      rest = rest.slice(m[0].length);
    }
    if (!times.length) continue; // [ar:Artist] and blank lines
    let words: CueWord[] | undefined;
    if (/<\d+:\d{2}(?:\.\d+)?>/.test(rest)) {
      const parts = rest.split(/<(\d+:\d{2}(?:\.\d+)?)>/);
      const ws: { text: string; t: number }[] = [];
      for (let i = 1; i < parts.length; i += 2) {
        const w = parts[i + 1]?.trim();
        const [mm, ss] = parts[i].split(":");
        if (w) for (const word of w.split(/\s+/)) ws.push({ text: word, t: Number(mm) * 60 + Number(ss) });
      }
      words = ws.map((w, i) => ({ text: w.text, start: ms(w.t), end: ms(ws[i + 1]?.t ?? w.t + 0.5) }));
    }
    const lyric = rest.replace(/<\d+:\d{2}(?:\.\d+)?>/g, "").replace(/\s+/g, " ").trim();
    for (const t of times) stamps.push({ t: ms(t), text: lyric, ...(words ? { words } : {}) });
  }
  stamps.sort((a, b) => a.t - b.t);
  const out: Cue[] = [];
  for (let i = 0; i < stamps.length; i++) {
    const s = stamps[i];
    if (!s.text) continue;
    const next = stamps[i + 1];
    const end = ms(next ? next.t : s.t + 4);
    const words = s.words?.map((w, k, a) => ({ ...w, end: k === a.length - 1 ? Math.min(end, Math.max(w.end, w.start)) : w.end }));
    out.push({ start: s.t, end, text: s.text, ...(words ? { words } : {}) });
  }
  return out;
}
export function toLrcText(cues: Cue[]): string {
  const rows: string[] = [];
  cues.forEach((c, i) => {
    rows.push(`[${lrcStamp(c.start)}]${c.words?.length ? c.words.map((w) => `<${lrcStamp(w.start)}>${w.text}`).join(" ") : c.text.replace(/\n/g, " ")}`);
    // a gap before the next line is written as an empty stamp so the end time survives
    const next = cues[i + 1];
    if (!next || next.start - c.end > 0.05) rows.push(`[${lrcStamp(c.end)}]`);
  });
  return rows.join("\n") + "\n";
}

/* ---------- ASS ---------- */

const assClock = (t: number) => {
  const cs = Math.round(t * 100);
  return `${Math.floor(cs / 360000)}:${p2(Math.floor(cs / 6000) % 60)}:${p2(Math.floor(cs / 100) % 60)}.${p2(cs % 100)}`;
};
export function parseAss(text: string): Cue[] {
  const out: Cue[] = [];
  let fields: string[] | null = null;
  let inEvents = false;
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (/^\[.*\]$/.test(line)) {
      inEvents = /^\[events\]$/i.test(line);
      continue;
    }
    if (!inEvents) continue;
    if (/^format:/i.test(line)) {
      fields = line.slice(7).split(",").map((f) => f.trim().toLowerCase());
      continue;
    }
    if (!/^dialogue:/i.test(line)) continue;
    const f = fields ?? ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];
    // the text is last and may hold commas: split only as many times as there are fields before it
    const vals: string[] = [];
    let rest = line.slice(9).trim();
    for (let i = 0; i < f.length - 1; i++) {
      const k = rest.indexOf(",");
      if (k < 0) break;
      vals.push(rest.slice(0, k));
      rest = rest.slice(k + 1);
    }
    vals.push(rest);
    const get = (n: string) => vals[f.indexOf(n)]?.trim() ?? "";
    const start = parseClock(get("start"));
    const end = parseClock(get("end"));
    if (start === null || end === null) continue;
    const src = vals[f.indexOf("text")] ?? "";
    // karaoke tags (\k, \kf, \ko) give word durations in centiseconds
    const words: CueWord[] = [];
    if (/\\k[fo]?\d/i.test(src)) {
      let t = start;
      for (const m of src.matchAll(/\{[^}]*?\\k[fo]?(\d+)[^}]*\}([^{]*)/gi)) {
        const d = Number(m[1]) / 100;
        const w = m[2].replace(/\\[Nn]/g, " ").trim();
        if (w) for (const word of w.split(/\s+/)) words.push({ text: word, start: ms(t), end: ms(t + d) });
        t += d;
      }
    }
    const body = tidyText(src.replace(/\{[^}]*\}/g, "").replace(/\\[Nn]/g, "\n").replace(/\\h/g, " "));
    const name = get("name");
    if (body) out.push({ start, end, text: body, ...(name ? { speaker: name } : {}), ...(words.length ? { words } : {}) });
  }
  return sortCues(out);
}
export function toAssText(cues: Cue[], o: { width?: number; height?: number; fontSize?: number } = {}): string {
  const W = o.width ?? 1920;
  const H = o.height ?? 1080;
  const head = [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${W}`, `PlayResY: ${H}`, "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,Arial,${o.fontSize ?? Math.round(H / 20)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,60,60,${Math.round(H / 12)},1`,
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const events = cues.map((c) => {
    // karaoke tags need one \k per word and no leftover text, so a cue is written with them only when the words are its text
    const body = c.words?.length ? c.words.map((w) => `{\\k${Math.max(1, Math.round((w.end - w.start) * 100))}}${w.text}`).join(" ") : c.text.replace(/\n/g, "\\N");
    return `Dialogue: 0,${assClock(c.start)},${assClock(c.end)},Default,${(c.speaker ?? "").replace(/,/g, " ")},0,0,0,,${body}`;
  });
  return [...head, ...events, ""].join("\n");
}

/* ---------- iTT / TTML ---------- */

export function parseItt(text: string): Cue[] {
  const fps = Number(/ttp:frameRate="([\d.]+)"/.exec(text)?.[1] ?? 30);
  const out: Cue[] = [];
  for (const m of text.matchAll(/<p\b([^>]*?)(?:\/>|>([\s\S]*?)<\/p>)/g)) {
    const attr = (n: string) => new RegExp(`(?:^|\\s)(?:\\w+:)?${n}="([^"]*)"`).exec(m[1])?.[1];
    const b = attr("begin");
    const e = attr("end");
    const d = attr("dur");
    const start = b ? parseClock(b, fps) : null;
    const end = e ? parseClock(e, fps) : start !== null && d ? (parseClock(d, fps) ?? 0) + start : null;
    if (start === null || end === null) continue;
    const speaker = attr("agent");
    const body = tidyText(decode((m[2] ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")));
    if (body) out.push({ start, end, text: body, ...(speaker ? { speaker: decode(speaker) } : {}) });
  }
  return sortCues(out);
}
export function toIttText(cues: Cue[], o: { lang?: string; fps?: number } = {}): string {
  const lang = o.lang ?? "en";
  const rows = cues.map((c) => `      <p begin="${clock(c.start, ".")}" end="${clock(c.end, ".")}"${c.speaker ? ` agent="${escapeXml(c.speaker)}"` : ""}>${c.text.split("\n").map(escapeXml).join("<br/>")}</p>`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" xml:lang="${lang}" ttp:timeBase="media" ttp:frameRate="${o.fps ?? 30}">`,
    '  <head><styling><style xml:id="s1" tts:textAlign="center" tts:color="white" tts:fontSize="100%"/></styling><layout/></head>',
    '  <body style="s1">',
    "    <div>",
    ...rows,
    "    </div>",
    "  </body>",
    "</tt>",
    "",
  ].join("\n");
}

/* ---------- by format ---------- */

/** The format a file is in, from its name and then its content. */
export function sniffFormat(name: string, text: string): CueFormat | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if (ext === "srt" || ext === "vtt" || ext === "lrc" || ext === "ass") return ext;
  if (ext === "ssa") return "ass";
  if (ext === "itt" || ext === "ttml" || ext === "dfxp" || ext === "xml") return "itt";
  const head = text.replace(/^﻿/, "").trimStart().slice(0, 400);
  if (/^WEBVTT/.test(head)) return "vtt";
  if (/^<\?xml|^<tt\b/.test(head)) return "itt";
  if (/^\[Script Info\]/i.test(head)) return "ass";
  if (/^\[\d{1,3}:\d{2}/m.test(head)) return "lrc";
  if (/-->/.test(head)) return "srt";
  return null;
}

export function parseCues(name: string, text: string): Cue[] {
  const f = sniffFormat(name, text);
  if (f === "vtt") return parseVtt(text);
  if (f === "lrc") return parseLrc(text);
  if (f === "ass") return parseAss(text);
  if (f === "itt") return parseItt(text);
  return parseSrt(text);
}

export function serializeCues(format: CueFormat, cues: Cue[], o: { lang?: string; fps?: number; width?: number; height?: number } = {}): string {
  const c = cues.map((x) => ({ ...x, start: ms(x.start), end: ms(x.end) }));
  if (format === "vtt") return toVttText(c);
  if (format === "lrc") return toLrcText(c);
  if (format === "ass") return toAssText(c, o);
  if (format === "itt") return toIttText(c, o);
  return toSrtText(c);
}
