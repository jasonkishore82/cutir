import { applyPatches, diff, type Patch, type Path } from "../../model/ops";

/**
 * Operation log merge (phase 29, on the phase 11 operations). Two people start from the same document and each make
 * changes. The server keeps one ordered log; a client that has changes of its own rebases them onto whatever came in
 * first. Patches address array items by index, which shifts when the other side adds or removes items, so each patch is
 * translated through item ids: "the clip with id c4" stays the same clip wherever it moved.
 *
 * Rules: an edit to something the other side deleted is dropped and reported; two edits to the same value keep the
 * later one (ours, applied last) and report it; everything else merges silently.
 */

type Seg = string | number | { id: string };
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const idOf = (v: unknown) => (isObj(v) && typeof v.id === "string" ? v.id : undefined);

/** A path with array indexes replaced by item ids where the item has one. Null when the path does not exist in `doc`. */
function toIdPath(doc: unknown, path: Path): Seg[] | null {
  const out: Seg[] = [];
  let node = doc;
  for (const k of path) {
    if (Array.isArray(node)) {
      const item = node[k as number];
      if (item === undefined) return null;
      const id = idOf(item);
      out.push(id ? { id } : (k as number));
      node = item;
    } else if (isObj(node)) {
      out.push(k);
      node = node[k as string];
    } else return null;
  }
  return out;
}

/** The index path of an id path in `doc`, or null when an item with that id is gone. */
function fromIdPath(doc: unknown, path: Seg[]): Path | null {
  const out: Path = [];
  let node = doc;
  for (const s of path) {
    if (Array.isArray(node)) {
      const i = typeof s === "object" ? node.findIndex((x) => idOf(x) === s.id) : (s as number);
      if (i < 0 || node[i] === undefined) return null;
      out.push(i);
      node = node[i];
    } else if (isObj(node)) {
      out.push(s as string);
      node = node[s as string];
    } else return null;
  }
  return out;
}

const keyOf = (p: Seg[]) => JSON.stringify(p);
const arrayAt = (doc: unknown, path: Path): unknown[] | null => {
  let n = doc;
  for (const k of path) n = Array.isArray(n) ? n[k as number] : isObj(n) ? n[k as string] : undefined;
  return Array.isArray(n) ? n : null;
};

export type Conflict = { patch: Patch; reason: "deleted-by-other" | "both-changed" };

/**
 * Rebase `local` (made on `base`) onto `target` (base plus the other side's changes). Returns patches that apply to
 * `target`, in order, and the conflicts found.
 */
export function rebase(base: unknown, remote: Patch[], local: Patch[]): { patches: Patch[]; conflicts: Conflict[]; doc: unknown } {
  const target = applyPatches(base, remote);
  // what the other side touched, in id form, to notice when both changed the same value
  const touched = new Set<string>();
  {
    let cur = base;
    for (const p of remote) {
      const ip = toIdPath(cur, p.path) ?? toIdPath(applyPatches(cur, [p]), p.path);
      if (ip && p.op !== "splice") touched.add(keyOf(ip));
      cur = applyPatches(cur, [p]);
    }
  }
  const out: Patch[] = [];
  const conflicts: Conflict[] = [];
  let before = base; // where the local patch was written: base plus the local patches so far
  let now = target; // the same place after rebasing
  for (const p of local) {
    const next = applyPatches(before, [p]);
    if (p.op === "splice") {
      const arr = arrayAt(before, p.path);
      const parent = toIdPath(before, p.path);
      const tpath = parent && fromIdPath(now, parent);
      const tarr = tpath && arrayAt(now, tpath);
      if (!arr || !tarr || !tpath) {
        conflicts.push({ patch: p, reason: "deleted-by-other" });
        before = next;
        continue;
      }
      const removed = arr.slice(p.index, p.index + p.remove);
      const keyed = removed.every((x) => idOf(x));
      const emit: Patch[] = [];
      if (p.remove) {
        if (keyed) {
          const idx = removed.map((x) => tarr.findIndex((y) => idOf(y) === idOf(x))).filter((i) => i >= 0).sort((a, b) => b - a);
          for (const i of idx) emit.push({ op: "splice", path: tpath, index: i, remove: 1, insert: [] });
          // already deleted by the other side: same result, nothing to do
        } else if (p.index + p.remove <= tarr.length && arr.length === tarr.length) emit.push({ ...p, path: tpath });
        else {
          conflicts.push({ patch: p, reason: "both-changed" });
          before = next;
          continue;
        }
      }
      if (p.insert.length) {
        const anchor = p.index > 0 ? idOf(arr[p.index - 1]) : undefined;
        let at = p.index === 0 ? 0 : tarr.length;
        if (anchor) {
          const ai = tarr.findIndex((y) => idOf(y) === anchor);
          at = ai >= 0 ? ai + 1 : tarr.length;
        } else if (p.index > 0) at = Math.min(p.index, tarr.length);
        // removals above shift the insert point
        const gone = emit.filter((e) => e.op === "splice" && e.index < at).length;
        emit.push({ op: "splice", path: tpath, index: Math.max(0, at - gone), remove: 0, insert: p.insert });
      }
      for (const e of emit) now = applyPatches(now, [e]);
      out.push(...emit);
      before = next;
      continue;
    }
    const parentPath = p.path.slice(0, -1);
    const parentIp = toIdPath(before, parentPath);
    const last = p.path[p.path.length - 1];
    const beforeParent = parentPath.length || Array.isArray(before) ? arrayAt(before, parentPath) : null;
    // the last step: an item id when the parent is a list of items, the key or index otherwise
    const lastSeg: Seg = beforeParent ? (idOf(beforeParent[last as number]) ? { id: idOf(beforeParent[last as number])! } : (last as number)) : last;
    const tp = parentIp && fromIdPath(now, parentIp);
    const full = tp ? (typeof lastSeg === "object" ? fromIdPath(now, [...parentIp!, lastSeg]) : [...tp, lastSeg]) : null;
    if (!full || (p.op === "del" && fromIdPath(now, [...parentIp!, lastSeg]) === null && typeof lastSeg === "object")) {
      conflicts.push({ patch: p, reason: "deleted-by-other" });
      before = next;
      continue;
    }
    if (p.op === "set" && touched.has(keyOf([...parentIp!, lastSeg]))) conflicts.push({ patch: p, reason: "both-changed" });
    const q: Patch = p.op === "set" ? { op: "set", path: full, value: p.value } : { op: "del", path: full };
    now = applyPatches(now, [q]);
    out.push(q);
    before = next;
  }
  return { patches: out, conflicts, doc: now };
}

/** Merge two sets of changes made on the same base: the other side's first, ours rebased on top. */
export function mergeDocs<T>(base: T, remote: T, local: T): { doc: T; conflicts: Conflict[] } {
  const r = rebase(base, diff(base, remote), diff(base, local));
  return { doc: r.doc as T, conflicts: r.conflicts };
}
