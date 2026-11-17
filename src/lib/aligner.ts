import type { LyricLine } from "../store/project";

export const DEFAULT_ALIGNER_URL = "http://127.0.0.1:8765";

export const ALIGNER_HELP =
  "Could not reach the aligner. Start it with: pip install -r tools/aligner/requirements.txt, then python tools/aligner/server.py";

/** Section tags such as [Verse 1] or [Chorus] (Suno adds these); they are not sung. */
export const isTagLine = (t: string) => /^\s*\[[^\]]*\]\s*$/.test(t);

export type AlignOptions = { language: string; model: string; separate: boolean };

/** `pct` (0..1) is only present while the helper can measure a stage (vocal separation). */
export type AlignProgress = { stage: "uploading" | "separating" | "loading" | "aligning"; pct?: number };

type ServerSegment = { text: string; start: number; end: number; words: { text: string; start: number; end: number }[] };
type ServerEvent =
  | { type: "stage"; stage: AlignProgress["stage"] }
  | { type: "progress"; stage: AlignProgress["stage"]; pct: number }
  | { type: "result"; lines: ServerSegment[]; matched: boolean; expected: number }
  | { type: "error"; message: string };

const base = (u: string) => u.trim().replace(/\/+$/, "") || DEFAULT_ALIGNER_URL;

export async function checkAligner(url: string, signal?: AbortSignal) {
  try {
    const res = await fetch(`${base(url)}/health`, { signal });
    if (!res.ok) throw new Error(`status ${res.status}`);
    return (await res.json()) as { ok: boolean; backend: string; model: string; ffmpeg: boolean };
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new Error(ALIGNER_HELP);
  }
}

/**
 * Align the sung lines to the song. Tag lines ([Chorus]...) are skipped and dropped from the result.
 * Returns lines with start/end and, when the word counts agree, per-word timings.
 */
export async function alignLines(
  url: string,
  audio: { url: string; name: string },
  lines: LyricLine[],
  opts: AlignOptions,
  signal?: AbortSignal,
  onProgress?: (p: AlignProgress) => void
): Promise<{ lines: LyricLine[]; skippedTags: number }> {
  const sung = lines.filter((l) => !isTagLine(l.text));
  if (!sung.length) throw new Error("There are no lyric lines to align.");

  onProgress?.({ stage: "uploading" });
  let blob: Blob;
  try {
    blob = await (await fetch(audio.url, { signal })).blob();
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new Error(`Could not read the uploaded song (${(e as Error).message}). Try uploading it again.`);
  }
  const form = new FormData();
  form.append("audio", new File([blob], audio.name || "song.mp3"));
  form.append("lyrics", sung.map((l) => l.text).join("\n"));
  form.append("language", opts.language || "en");
  form.append("model", opts.model);
  form.append("separate", String(opts.separate));

  let res: Response;
  try {
    res = await fetch(`${base(url)}/align_stream`, { method: "POST", body: form, signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new Error(ALIGNER_HELP);
  }
  if (!res.ok || !res.body) {
    let msg = `The aligner answered ${res.status}`;
    try {
      const j = await res.json();
      if (typeof j?.detail === "string") msg = j.detail;
    } catch {
      /* keep default */
    }
    throw new Error(msg);
  }

  /* read the NDJSON progress stream */
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let result: Extract<ServerEvent, { type: "result" }> | null = null;

  const handle = (line: string) => {
    if (!line.trim()) return;
    const ev = JSON.parse(line) as ServerEvent;
    if (ev.type === "stage") onProgress?.({ stage: ev.stage });
    else if (ev.type === "progress") onProgress?.({ stage: ev.stage, pct: ev.pct });
    else if (ev.type === "error") throw new Error(ev.message);
    else if (ev.type === "result") result = ev;
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      handle(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  handle(buf);

  const data = result as Extract<ServerEvent, { type: "result" }> | null;
  if (!data) throw new Error("The aligner stopped without sending a result.");
  if (!data.matched || data.lines.length !== sung.length) {
    throw new Error(
      `The aligner returned ${data.lines.length} segments for ${sung.length} lyric lines. Check the lyrics, or try a larger model.`
    );
  }

  const out = sung.map((l, i) => {
    const seg = data.lines[i];
    const start = Math.max(0, seg.start);
    const end = Math.max(seg.end, start + 0.1);
    const wordCount = l.text.split(/\s+/).filter(Boolean).length;
    const words = seg.words.length === wordCount ? seg.words : undefined; // only trust words that line up with the text
    return { ...l, start, end, words };
  });
  return { lines: out, skippedTags: lines.length - sung.length };
}
