// Poster palettes (src/lib/palettes.ts).
import { POSTER_PALETTES, applyPalette } from "../src/lib/palettes";
import { defaultProject } from "../src/store/project";

let fails = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got ${JSON.stringify(got)?.slice(0, 400)}`}`);
}

const base = defaultProject();
const navy = POSTER_PALETTES.find((p) => p.id === "navy")!;
const out = applyPalette(base, navy);
check("background becomes flat", out.background.type === "gradient" && out.background.colors.every((c) => c === navy.bg) && !out.background.noise, out.background);
check("text and accent colours are set", out.style.color === navy.text && out.style.highlight.color === navy.accent, out.style);
check("the original project is untouched", base.style.color !== navy.text);
check("nine palettes", POSTER_PALETTES.length === 9);

if (fails) process.exit(1);
console.log("all passed");
