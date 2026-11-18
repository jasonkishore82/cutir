import { useEffect, useState } from "react";

const WORDS = [
  "Coalescing", "Cooking", "Cutting", "Clapping", "Splicing", "Trimming", "Syncing",
  "Mixing", "Grading", "Rendering", "Scoring", "Conjuring", "Editing", "Rolling",
  "Shimmying", "Percolating", "Noodling", "Pondering", "Choreographing",
];
const GLYPHS = ["·", "✢", "✱", "✶", "✻", "✽", "✻", "✶", "✱", "✢"];

const pick = (not?: string) => {
  let w = WORDS[Math.floor(Math.random() * WORDS.length)];
  while (w === not) w = WORDS[Math.floor(Math.random() * WORDS.length)];
  return w;
};

/** Claude-style "thinking" buffer: spinning glyph, rotating verb with a shimmer, elapsed seconds. */
export default function Thinking({ tokens = 0 }: { tokens?: number }) {
  const [word, setWord] = useState(() => pick());
  const [glyph, setGlyph] = useState(0);
  const [secs, setSecs] = useState(0);

  useEffect(() => {
    const g = setInterval(() => setGlyph((i) => (i + 1) % GLYPHS.length), 140);
    const w = setInterval(() => setWord((cur) => pick(cur)), 2200);
    const t0 = Date.now();
    const s = setInterval(() => setSecs(Math.floor((Date.now() - t0) / 1000)), 500);
    return () => {
      clearInterval(g);
      clearInterval(w);
      clearInterval(s);
    };
  }, []);

  return (
    <div className="space-y-1.5 text-sm" role="status" aria-live="polite">
      <div className="flex items-center gap-2 text-xs text-gray-500">
        <span>Thinking…</span>
        <span className="tabular-nums">· {tokens} token{tokens === 1 ? "" : "s"}</span>
        <span className="tabular-nums">· {secs}s</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-4 text-center text-sky-400 text-base leading-none">{GLYPHS[glyph]}</span>
        <span className="shimmer font-medium">{word}…</span>
      </div>
    </div>
  );
}
