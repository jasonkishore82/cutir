/**
 * Operations: every change to the project document is a list of patches plus the patches that undo it.
 * Patches are plain JSON data (no functions, no class instances), so they can be stored as undo history, sent to a
 * worker, replayed or synced. Applying a patch copies only the objects along its path; the rest of the document is
 * shared with the previous version.
 */

export type Path = (string | number)[];

export type Patch =
  | { op: "set"; path: Path; value: unknown }
  | { op: "del"; path: Path }
  /** Array edit: remove `remove` items at `index`, then insert `insert` there. */
  | { op: "splice"; path: Path; index: number; remove: number; insert: unknown[] };

export type Operation = { label?: string; patches: Patch[]; inverse: Patch[] };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const idOf = (v: unknown) => (isObj(v) && typeof v.id === "string" ? v.id : undefined);

/* ---------- diff ---------- */

/** Patches that turn `a` into `b`. Unchanged subtrees (same reference or equal content) produce nothing. */
export function diff(a: unknown, b: unknown, path: Path = [], out: Patch[] = []): Patch[] {
  if (a === b) return out;
  if (isObj(a) && isObj(b)) {
    for (const k of Object.keys(a)) {
      if (!(k in b) || b[k] === undefined) {
        if (a[k] !== undefined) out.push({ op: "del", path: [...path, k] });
      } else diff(a[k], b[k], [...path, k], out);
    }
    for (const k of Object.keys(b)) if ((!(k in a) || a[k] === undefined) && b[k] !== undefined) out.push({ op: "set", path: [...path, k], value: b[k] });
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) return diffArray(a, b, path, out);
  if (Number.isNaN(a) && Number.isNaN(b)) return out;
  out.push({ op: "set", path, value: b });
  return out;
}

function diffArray(a: unknown[], b: unknown[], path: Path, out: Patch[]): Patch[] {
  const ids = (xs: unknown[]) => xs.map(idOf);
  const ia = ids(a);
  const ib = ids(b);
  const keyed = ia.every(Boolean) && ib.every(Boolean) && new Set(ia).size === ia.length && new Set(ib).size === ib.length;

  if (a.length === b.length && (!keyed || ia.every((id, i) => id === ib[i]))) {
    a.forEach((x, i) => diff(x, b[i], [...path, i], out));
    return out;
  }
  if (keyed) {
    // items kept by both must stay in the same relative order; otherwise replace the array
    const inB = new Set(ib);
    const inA = new Set(ia);
    const keptA = ia.filter((id) => inB.has(id));
    const keptB = ib.filter((id) => inA.has(id));
    if (keptA.every((id, i) => id === keptB[i])) {
      for (let i = a.length - 1; i >= 0; i--) if (!inB.has(ia[i]!)) out.push({ op: "splice", path, index: i, remove: 1, insert: [] });
      b.forEach((x, j) => {
        if (!inA.has(ib[j]!)) out.push({ op: "splice", path, index: j, remove: 0, insert: [x] });
      });
      const byId = new Map(a.map((x) => [idOf(x)!, x]));
      b.forEach((x, j) => {
        const old = byId.get(ib[j]!);
        if (old !== undefined) diff(old, x, [...path, j], out);
      });
      return out;
    }
  }
  out.push({ op: "set", path, value: b });
  return out;
}

/* ---------- apply ---------- */

function applyOne(root: unknown, p: Patch): unknown {
  const go = (node: unknown, depth: number): unknown => {
    if (depth === p.path.length) {
      if (p.op === "set") return p.value;
      if (p.op === "splice") {
        const arr = [...(node as unknown[])];
        arr.splice(p.index, p.remove, ...p.insert);
        return arr;
      }
      throw new Error("del needs a parent");
    }
    const key = p.path[depth];
    const last = depth === p.path.length - 1;
    if (Array.isArray(node)) {
      const arr = [...node];
      if (last && p.op === "del") arr.splice(key as number, 1);
      else arr[key as number] = go(node[key as number], depth + 1);
      return arr;
    }
    const obj: Obj = { ...((node as Obj) ?? {}) };
    if (last && p.op === "del") delete obj[key as string];
    else obj[key as string] = go(obj[key as string], depth + 1);
    return obj;
  };
  return go(root, 0);
}

export function applyPatches<T>(doc: T, patches: Patch[]): T {
  let out: unknown = doc;
  for (const p of patches) out = applyOne(out, p);
  return out as T;
}

/* ---------- operations ---------- */

/** The operation that turns `before` into `after`, with its inverse. Null when nothing changed. */
export function makeOperation<T>(before: T, after: T, label?: string): Operation | null {
  const patches = diff(before, after);
  if (!patches.length) return null;
  return { label, patches, inverse: diff(after, before) };
}

export const applyOperation = <T>(doc: T, op: Operation): T => applyPatches(doc, op.patches);
export const revertOperation = <T>(doc: T, op: Operation): T => applyPatches(doc, op.inverse);
