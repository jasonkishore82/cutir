// Collage layout (src/lib/collage.ts).
import { applyCollageLayout } from "../src/lib/collage";
import { defaultProject, resolveStyle, type LyricLine, type Project } from "../src/store/project";

let fails = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got ${JSON.stringify(got)?.slice(0, 400)}`}`);
}

const lines: LyricLine[] = Array.from({ length: 9 }, (_, i) => ({ id: `l${i}`, text: `word ${i}`, start: i * 2, end: i * 2 + 2 }));
const base: Project = { ...defaultProject(), lines };
const pos = (p: Project, i: number) => {
  const t = resolveStyle(p, p.lines[i]).transform;
  return [t.x, t.y, t.scale, t.rotation] as const;
};

const a = applyCollageLayout(base, undefined, 7);
check("every line gets a place, size and tilt", a.lines.every((_, i) => pos(a, i).every((v) => typeof v === "number")));
check("positions stay inside the frame", a.lines.every((_, i) => pos(a, i)[0]! > 0.1 && pos(a, i)[0]! < 0.9 && pos(a, i)[1]! > 0.15 && pos(a, i)[1]! < 0.85));
check("every third line is big", [0, 3, 6].every((i) => pos(a, i)[2]! > 1.2) && [1, 2, 4].every((i) => pos(a, i)[2]! < 1.1));
const same = (i: number) => Math.abs(pos(a, i)[0]! - pos(a, i + 1)[0]!) < 0.08 && Math.abs(pos(a, i)[1]! - pos(a, i + 1)[1]!) < 0.08;
check("neighbouring lines do not sit on top of each other", [0, 1, 2, 3, 4, 5, 6, 7].every((i) => !same(i)));
check("same seed, same layout", JSON.stringify(applyCollageLayout(base, undefined, 7)) === JSON.stringify(a));
check("another seed, another layout", JSON.stringify(applyCollageLayout(base, undefined, 8)) !== JSON.stringify(a));
const only = applyCollageLayout(base, ["l2"], 7);
check("limited to chosen lines", only.lines[2].styleOverride?.transform?.x !== undefined && !only.lines[0].styleOverride && !only.lines[5].styleOverride);
check("fonts and animation untouched", JSON.stringify(a.lines[0].styleOverride?.animation) === undefined && a.lines[0].styleOverride?.fontFamily === undefined);

if (fails) process.exit(1);
console.log("all passed");
