// Keyframes: interpolation, holding, per-property keys, easing, split and merge (src/lib/keyframes.ts).
import { evalKeyframes, keyLineAt, mergeKeyframes, splitKeyframes } from "../src/lib/keyframes";

let fails = 0;
const near = (a: number, b: number) => Math.abs(a - b) < 1e-3;
function check(name: string, ok: boolean, got?: unknown) {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got ${JSON.stringify(got)}`}`);
}

const kfs = [
  { id: "a", time: 0, props: { x: 0, opacity: 0 }, easing: "linear" as const },
  { id: "b", time: 2, props: { x: 0.5 }, easing: "linear" as const },
  { id: "c", time: 4, props: { x: 0.1, opacity: 1 }, easing: "linear" as const },
];

check("empty -> rest", JSON.stringify(evalKeyframes(undefined, 1)) === JSON.stringify({ x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }));
check("x halfway 0->0.5 at t=1", near(evalKeyframes(kfs, 1).x, 0.25), evalKeyframes(kfs, 1).x);
check("x between b and c at t=3", near(evalKeyframes(kfs, 3).x, 0.3), evalKeyframes(kfs, 3).x);
check("opacity skips b (only a,c key it)", near(evalKeyframes(kfs, 2).opacity, 0.5), evalKeyframes(kfs, 2).opacity);
check("holds before first", near(evalKeyframes(kfs, -1).x, 0));
check("holds after last", near(evalKeyframes(kfs, 9).x, 0.1));
check("unkeyed prop stays at rest", near(evalKeyframes(kfs, 1).scale, 1) && near(evalKeyframes(kfs, 1).y, 0));
const eased = [{ ...kfs[0], easing: "ease-in" as const }, kfs[1]];
check("easing of earlier keyframe is used", near(evalKeyframes(eased, 1).x, 0.5 * 0.125), evalKeyframes(eased, 1).x);

// split at 3s: both halves agree at the cut and keep the motion
const [first, second] = splitKeyframes(kfs, 3);
check("first half ends at the cut value", near(evalKeyframes(first, 3).x, 0.3), evalKeyframes(first, 3).x);
check("second half starts at the cut value", near(evalKeyframes(second, 0).x, 0.3), evalKeyframes(second, 0).x);
check("second half reaches c 1s later", near(evalKeyframes(second, 1).x, 0.1), evalKeyframes(second, 1).x);
check("first half keeps a and b", first!.filter((k) => k.id === "a" || k.id === "b").length === 2);
for (const t of [0.5, 1.5, 2.5]) check(`first half matches original at ${t}`, near(evalKeyframes(first, t).x, evalKeyframes(kfs, t).x));
check("split of nothing", JSON.stringify(splitKeyframes(undefined, 1)) === "[null,null]");

// merge: line B starting 5s later keeps its absolute timing
const A = { id: "A", text: "a", start: 10, end: 12, keyframes: [kfs[0]] };
const B = { id: "B", text: "b", start: 15, end: 18, keyframes: [{ ...kfs[1], time: 1 }] };
const m = mergeKeyframes(A, B, 10)!;
check("merge shifts B's keys by its offset", m.length === 2 && near(m[1].time, 6), m);

// keyLineAt merges into an existing keyframe at the same time and clamps to the line
const line = { id: "L", text: "x", start: 0, end: 4, keyframes: kfs };
const r1 = keyLineAt(line, 2.004, { y: 0.2 });
check("keying near b merges into b", r1.id === "b" && r1.line.keyframes!.length === 3 && r1.line.keyframes![1].props.y === 0.2, r1.line.keyframes);
const r2 = keyLineAt(line, 10, { x: 1 });
check("keying past the end clamps to the end", r1.line.keyframes && r2.line.keyframes!.some((k) => near(k.time, 4) && k.props.x === 1), r2.line.keyframes);

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
