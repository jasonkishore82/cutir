import { editProjectStyle } from "./styleEdit";
import type { Project } from "../store/project";

/** Small seeded random generator (mulberry32), so the same seed gives the same layout. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Centres of a 3 x 3 grid inside the safe area (fractions of the canvas), in reading order. */
const CELLS: [number, number][] = [];
for (const y of [0.28, 0.5, 0.72]) for (const x of [0.25, 0.5, 0.75]) CELLS.push([x, y]);

/**
 * Collage layout: gives each line its own place, size and tilt, like kinetic posters. Every few lines one is big and
 * near the middle; the rest are smaller, tilted and pushed to other cells. A line never lands in the same cell as the
 * one before it. Only the free-placement fields (x, y, scale, rotation) are written, so fonts, colours and
 * animations stay as they are. `lineIds` limits it to those lines (all lines when missing).
 */
export function applyCollageLayout(project: Project, lineIds?: string[], seed = 1): Project {
  const want = lineIds?.length ? new Set(lineIds) : null;
  const rand = rng(seed);
  const sorted = [...project.lines].filter((l) => !want || want.has(l.id)).sort((a, b) => a.start - b.start);
  let p = project;
  let prev = -1;
  sorted.forEach((line, i) => {
    const big = i % 3 === 0;
    let cell: number;
    do cell = big ? 4 + Math.floor(rand() * 3 - 1) * (rand() < 0.5 ? 1 : 3) : Math.floor(rand() * CELLS.length);
    while (cell === prev || cell < 0 || cell >= CELLS.length);
    prev = cell;
    const [cx, cy] = CELLS[cell];
    const jitter = () => (rand() - 0.5) * 0.06;
    const scale = big ? 1.35 + rand() * 0.25 : 0.65 + rand() * 0.35;
    const rotation = big ? (rand() - 0.5) * 6 : (rand() < 0.2 ? 0 : (rand() < 0.5 ? -1 : 1) * (3 + rand() * 7));
    const r = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
    p = editProjectStyle(p, { scope: "line", ids: [line.id] }, {
      set: [
        ["transform.x", r(cx + jitter())],
        ["transform.y", r(cy + jitter())],
        ["transform.scale", r(scale, 2)],
        ["transform.rotation", r(rotation, 1)],
      ],
    });
  });
  return p;
}
