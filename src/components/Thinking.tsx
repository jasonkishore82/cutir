import { useEffect, useState } from "react";

const WORDS = [
  "Generating", "Pondering", "Cooking", "Splicing", "Trimming", "Syncing", "Mixing",
  "Grading", "Rendering", "Scoring", "Conjuring", "Editing", "Noodling", "Choreographing",
];
// the asterisk "breathes": small -> large -> small
const GLYPHS = ["✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳"];

const pick = (not?: string) => {
  let w = WORDS[Math.floor(Math.random() * WORDS.length)];
  while (w === not) w = WORDS[Math.floor(Math.random() * WORDS.length)];
  return w;
};

/** Claude Code-style buffer while a reply is on its way: animated blue-gradient asterisk, a shimmering verb, elapsed time and tokens. */
export default function Thinking({ tokens = 0 }: { tokens?: number }) {
  const [word, setWord] = useState("Generating");
  const [glyph, setGlyph] = useState(0);
  const [secs, setSecs] = useState(0);

  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const t0 = Date.now();
    const s = setInterval(() => setSecs(Math.floor((Date.now() - t0) / 1000)), 500);
    const g = reduce ? 0 : setInterval(() => setGlyph((i) => (i + 1) % GLYPHS.length), 120);
    const w = setInterval(() => setWord((cur) => pick(cur)), 3000);
    return () => {
      clearInterval(s);
      clearInterval(g);
      clearInterval(w);
    };
  }, []);

  return (
    <div className="flex items-center gap-2 text-[13px]" role="status" aria-live="polite">
      <span className="glyph-gradient w-4 text-center text-base leading-none" aria-hidden>
        {GLYPHS[glyph]}
      </span>
      <span className="shimmer font-medium">{word}…</span>
      <span className="tabular-nums text-[11px] text-gray-500">
        {secs}s{tokens > 0 ? ` · ${tokens} tokens` : ""}
      </span>
    </div>
  );
}
