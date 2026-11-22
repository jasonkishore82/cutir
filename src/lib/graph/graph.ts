/**
 * The per-clip node graph (phase 22). A graph is a list of nodes; each node names the nodes feeding its inputs.
 * The simple effect stack of phase 17 is the default view of the same thing: `stackToGraph` and `graphToStack`
 * convert between them, so a linear graph can always go back to a stack. Evaluation is generic over the picture
 * type, so the compositor runs it on canvas layers and the tests run it on plain values.
 */
import type { BlendMode, ClipEffect, Generator } from "../../model/types";

export type NodeType = "input" | "effect" | "merge" | "generator" | "output" | "transform" | "mask" | "text" | "group";

export type GraphNode = {
  id: string;
  type: NodeType;
  name?: string;
  /** Position in the editor. */
  x: number;
  y: number;
  /** A bypassed node passes its first input through (a bypassed generator is empty). */
  bypass?: boolean;
  /** Ids of the nodes feeding this one: effect and output take 1, merge takes 2 (background, foreground). */
  inputs: (string | null)[];
  effect?: Pick<ClipEffect, "type" | "params" | "keys">;
  merge?: { mode: BlendMode; opacity: number };
  generator?: Generator;
  /** Move, scale, turn and fade the picture (phase 22). x and y are shifts in frame fractions. */
  transform?: { x: number; y: number; scale: number; rotation: number; opacity: number };
  /** The same settings as the Mask effect. When a picture is connected to the second input it is the matte instead (its alpha). */
  mask?: Pick<ClipEffect, "params" | "keys">;
  /** A line of text drawn on its own (no input). */
  text?: { text: string; color: string; size: number; x: number; y: number; font?: string };
  /** A group: the nodes inside it as a graph of its own, with an input and an output node. It reads one picture and gives one. */
  group?: Graph;
};

export type Graph = { nodes: GraphNode[]; /** The node shown in the viewer instead of the output (preview from any node). */ preview?: string | null };

let seq = 0;
export const newNodeId = () => `n-${Date.now().toString(36)}${(seq++).toString(36)}`;

export const INPUT_COUNT: Record<NodeType, number> = { input: 0, effect: 1, merge: 2, generator: 0, output: 1, transform: 1, mask: 2, text: 0, group: 1 };

/** Node types with nothing to connect to their input side. */
export const SOURCE_TYPES: NodeType[] = ["input", "generator", "text"];

export const DEFAULT_TRANSFORM = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
export const DEFAULT_TEXT = { text: "Text", color: "#ffffff", size: 0.1, x: 0.5, y: 0.5 };

/** A chain input -> effects -> output laid out left to right: the stack as a graph. Disabled effects stay as bypassed nodes. */
export function stackToGraph(stack: ClipEffect[]): Graph {
  const nodes: GraphNode[] = [{ id: "in", type: "input", name: "Media in", x: 20, y: 40, inputs: [] }];
  let prev = "in";
  stack.forEach((fx, i) => {
    const id = `fx-${fx.id}`;
    nodes.push({ id, type: "effect", name: fx.type, x: 20 + (i + 1) * 150, y: 40, bypass: !fx.enabled || undefined, inputs: [prev], effect: { type: fx.type, params: fx.params, ...(fx.keys ? { keys: fx.keys } : {}) } });
    prev = id;
  });
  nodes.push({ id: "out", type: "output", name: "Media out", x: 20 + (stack.length + 1) * 150, y: 40, inputs: [prev] });
  return { nodes };
}

/** The effect stack of a graph that is a plain chain from the input to the output, or null when it branches. */
export function graphToStack(g: Graph, makeId: (n: GraphNode) => string = (n) => n.id.replace(/^fx-/, "")): ClipEffect[] | null {
  if (!isLinear(g)) return null;
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const out = g.nodes.find((n) => n.type === "output")!;
  const chain: GraphNode[] = [];
  let cur = byId.get(out.inputs[0]!);
  while (cur && cur.type === "effect") {
    chain.unshift(cur);
    cur = cur.inputs[0] ? byId.get(cur.inputs[0]) : undefined;
  }
  return chain.map((n) => ({ id: makeId(n), type: n.effect!.type, enabled: !n.bypass, params: n.effect!.params, ...(n.effect!.keys ? { keys: n.effect!.keys } : {}) }));
}

/** One input, one output and only single-input effect nodes between them, all connected in one line. */
export function isLinear(g: Graph): boolean {
  const out = g.nodes.filter((n) => n.type === "output");
  const inp = g.nodes.filter((n) => n.type === "input");
  if (out.length !== 1 || inp.length !== 1) return false;
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  let count = 1; // the output
  let cur = byId.get(out[0].inputs[0] ?? "");
  const seen = new Set<string>();
  while (cur && cur.type === "effect") {
    if (seen.has(cur.id)) return false;
    seen.add(cur.id);
    count++;
    cur = byId.get(cur.inputs[0] ?? "");
  }
  count++; // the input
  return cur?.type === "input" && count === g.nodes.length;
}

/** Problems that stop a graph from being evaluated; empty means fine. */
export function validateGraph(g: Graph): string[] {
  const errs: string[] = [];
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  if (byId.size !== g.nodes.length) errs.push("Two nodes share an id.");
  if (g.nodes.filter((n) => n.type === "output").length !== 1) errs.push("A graph needs exactly one output node.");
  for (const n of g.nodes) {
    for (const i of n.inputs) if (i && !byId.has(i)) errs.push(`${n.name ?? n.id} reads a node that does not exist.`);
    if (n.type === "effect" && !n.effect) errs.push(`${n.name ?? n.id} has no effect.`);
    if (n.type === "group") {
      if (!n.group) errs.push(`${n.name ?? n.id} is an empty group.`);
      else for (const e of validateGraph(n.group)) errs.push(`In ${n.name ?? n.id}: ${e}`);
    }
    if (n.type === "merge" && n.inputs.filter(Boolean).length < 1) errs.push(`${n.name ?? n.id} has nothing connected.`);
  }
  if (hasCycle(g)) errs.push("The graph has a loop.");
  return errs;
}

export function hasCycle(g: Graph): boolean {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 2) return false;
    if (state.get(id) === 1) return true;
    state.set(id, 1);
    for (const i of byId.get(id)?.inputs ?? []) if (i && byId.has(i) && visit(i)) return true;
    state.set(id, 2);
    return false;
  };
  return g.nodes.some((n) => visit(n.id));
}

/** Connect `from`'s output to input `slot` of `to`. Refuses a connection that would make a loop. */
export function connect(g: Graph, from: string, to: string, slot = 0): Graph | null {
  const target = g.nodes.find((n) => n.id === to);
  if (!target || from === to || SOURCE_TYPES.includes(target.type) || slot >= INPUT_COUNT[target.type]) return null;
  const next: Graph = { ...g, nodes: g.nodes.map((n) => (n.id === to ? { ...n, inputs: Object.assign([...n.inputs], { [slot]: from }) } : n)) };
  return hasCycle(next) ? null : next;
}

export const disconnect = (g: Graph, to: string, slot: number): Graph => ({ ...g, nodes: g.nodes.map((n) => (n.id === to ? { ...n, inputs: Object.assign([...n.inputs], { [slot]: null }) } : n)) });

/** Remove a node; whatever read it loses that input. Input and output nodes stay. */
export function removeNode(g: Graph, id: string): Graph {
  const n = g.nodes.find((x) => x.id === id);
  if (!n || n.type === "input" || n.type === "output") return g;
  return { ...g, preview: g.preview === id ? null : g.preview, nodes: g.nodes.filter((x) => x.id !== id).map((x) => ({ ...x, inputs: x.inputs.map((i) => (i === id ? null : i)) })) };
}

/** Insert a new node on the wire into the output (or at the end when nothing is connected). */
export function addNode(g: Graph, node: Omit<GraphNode, "id" | "inputs" | "x" | "y"> & Partial<Pick<GraphNode, "id">>): Graph {
  const out = g.nodes.find((n) => n.type === "output")!;
  const id = node.id ?? newNodeId();
  const feed = out.inputs[0];
  const maxX = Math.max(...g.nodes.map((n) => n.x));
  const inputs = Array.from({ length: INPUT_COUNT[node.type] }, (_, i) => (i === 0 ? feed ?? null : null));
  const made: GraphNode = { ...node, id, inputs, x: maxX, y: 40 + (g.nodes.length % 3) * 70 };
  return { ...g, nodes: [...g.nodes.map((n) => (n.id === out.id ? { ...n, inputs: [id], x: maxX + 150 } : n)), made] };
}

/** Nodes in an order where every node comes after the ones it reads (those reachable from `root`). */
export function evalOrder(g: Graph, root: string): GraphNode[] {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const out: GraphNode[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const n = byId.get(id);
    if (!n) return;
    for (const i of n.inputs) if (i) visit(i);
    out.push(n);
  };
  visit(root);
  return out;
}

export type GraphOps<T> = {
  input: () => T;
  /** Move, scale, turn and fade a picture (transform nodes). Without it a transform node passes its picture through. */
  transform?: (node: GraphNode, src: T) => T;
  /** Cut a picture to a mask (mask nodes), by the matte when one is connected. */
  mask?: (node: GraphNode, src: T, matte: T | null) => T;
  /** Draw a text node. */
  text?: (node: GraphNode) => T | null;
  /** Run a node's effect on its picture. */
  effect: (node: GraphNode, src: T) => T;
  /** Blend `fg` over `bg` (either may be missing when not connected). */
  merge: (node: GraphNode, bg: T | null, fg: T | null) => T | null;
  generator: (node: GraphNode) => T | null;
};

/**
 * Evaluate the graph from the output (or the preview node). Each node runs once even when several nodes read it.
 * Returns null when the chain ends in nothing (a disconnected output).
 */
export function evaluateGraph<T>(g: Graph, ops: GraphOps<T>): T | null {
  const root = g.preview && g.nodes.some((n) => n.id === g.preview) ? g.preview : g.nodes.find((n) => n.type === "output")?.id;
  if (!root || hasCycle(g)) return null;
  const done = new Map<string, T | null>();
  const get = (id: string | null): T | null => (id ? done.get(id) ?? null : null);
  for (const n of evalOrder(g, root)) {
    let v: T | null;
    if (n.type === "input") v = ops.input();
    else if (n.type === "generator") v = n.bypass ? null : ops.generator(n);
    else if (n.type === "text") v = n.bypass || !ops.text ? null : ops.text(n);
    else if (n.type === "transform") {
      const src = get(n.inputs[0]);
      v = !src ? null : n.bypass || !ops.transform ? src : ops.transform(n, src);
    } else if (n.type === "mask") {
      const src = get(n.inputs[0]);
      v = !src ? null : n.bypass || !ops.mask ? src : ops.mask(n, src, get(n.inputs[1]));
    } else if (n.type === "group") {
      const src = get(n.inputs[0]);
      // the group's inside is a graph of its own whose input is the picture that comes in
      v = !src ? null : n.bypass || !n.group ? src : evaluateGraph(n.group, { ...ops, input: () => src });
    } else if (n.type === "output") v = get(n.inputs[0]);
    else if (n.type === "effect") {
      const src = get(n.inputs[0]);
      v = !src ? null : n.bypass ? src : ops.effect(n, src);
    } else {
      const bg = get(n.inputs[0]);
      const fg = get(n.inputs[1]);
      v = n.bypass ? bg : ops.merge(n, bg, fg);
    }
    done.set(n.id, v);
  }
  return get(root);
}

/* ---------- groups ---------- */

const outsideReaders = (g: Graph, ids: Set<string>) => g.nodes.filter((n) => !ids.has(n.id) && n.inputs.some((i) => i && ids.has(i)));

/**
 * Collapse some nodes into one group node. The group reads one picture and gives one, so the nodes must have at most
 * one outside node feeding them and exactly one of them read from outside (or by the output). Returns an error in
 * plain words when that is not so.
 */
export function groupNodes(g: Graph, ids: string[], name = "Group"): { graph: Graph } | { error: string } {
  const set = new Set(ids);
  const picked = g.nodes.filter((n) => set.has(n.id));
  if (!picked.length) return { error: "Select the nodes to group first." };
  if (picked.some((n) => n.type === "input" || n.type === "output")) return { error: "The input and output nodes cannot go into a group." };
  const sources = new Set<string>();
  for (const n of picked) for (const i of n.inputs) if (i && !set.has(i)) sources.add(i);
  if (sources.size > 1) return { error: "These nodes read from more than one node outside the group. A group has one input; connect them through one node first." };
  const outs = new Set<string>();
  for (const r of outsideReaders(g, set)) for (const i of r.inputs) if (i && set.has(i)) outs.add(i);
  if (outs.size !== 1) return { error: outs.size ? "More than one of these nodes is used outside the group. A group has one output." : "Nothing outside reads these nodes, so there is nothing for the group to give." };
  const source = [...sources][0] ?? null;
  const outId = [...outs][0];
  const gid = newNodeId();
  const inner: Graph = {
    nodes: [
      { id: "in", type: "input", name: "Group in", x: Math.min(...picked.map((n) => n.x)) - 150, y: picked[0].y, inputs: [] },
      ...picked.map((n) => ({ ...n, inputs: n.inputs.map((i) => (i && !set.has(i) ? "in" : i)) })),
      { id: "out", type: "output", name: "Group out", x: Math.max(...picked.map((n) => n.x)) + 150, y: picked[0].y, inputs: [outId] },
    ],
  };
  const node: GraphNode = { id: gid, type: "group", name, x: Math.min(...picked.map((n) => n.x)), y: Math.min(...picked.map((n) => n.y)), inputs: [source], group: inner };
  const kept = g.nodes.filter((n) => !set.has(n.id)).map((n) => ({ ...n, inputs: n.inputs.map((i) => (i === outId ? gid : i)) }));
  return { graph: { ...g, preview: g.preview && set.has(g.preview) ? null : g.preview, nodes: [...kept, node] } };
}

/** Open a group back into its nodes. Its inside nodes get the group's id as a prefix so ids stay unique. */
export function ungroup(g: Graph, id: string): Graph {
  const gn = g.nodes.find((n) => n.id === id);
  if (!gn || gn.type !== "group" || !gn.group) return g;
  const pre = (i: string) => `${gn.id}.${i}`;
  const innerOut = gn.group.nodes.find((n) => n.type === "output");
  const innerIn = gn.group.nodes.find((n) => n.type === "input");
  const exit = innerOut?.inputs[0] ? pre(innerOut.inputs[0]) : null;
  const inside = gn.group.nodes
    .filter((n) => n.type !== "input" && n.type !== "output")
    .map((n) => ({ ...n, id: pre(n.id), inputs: n.inputs.map((i) => (i === innerIn?.id ? gn.inputs[0] ?? null : i ? pre(i) : null)) }));
  const rest = g.nodes.filter((n) => n.id !== id).map((n) => ({ ...n, inputs: n.inputs.map((i) => (i === id ? exit : i)) }));
  return { ...g, preview: g.preview === id ? null : g.preview, nodes: [...rest, ...inside] };
}
