/**
 * The per-clip node graph (phase 22). A graph is a list of nodes; each node names the nodes feeding its inputs.
 * The simple effect stack of phase 17 is the default view of the same thing: `stackToGraph` and `graphToStack`
 * convert between them, so a linear graph can always go back to a stack. Evaluation is generic over the picture
 * type, so the compositor runs it on canvas layers and the tests run it on plain values.
 */
import type { BlendMode, ClipEffect, Generator } from "../../model/types";

export type NodeType = "input" | "effect" | "merge" | "generator" | "output";

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
};

export type Graph = { nodes: GraphNode[]; /** The node shown in the viewer instead of the output (preview from any node). */ preview?: string | null };

let seq = 0;
export const newNodeId = () => `n-${Date.now().toString(36)}${(seq++).toString(36)}`;

export const INPUT_COUNT: Record<NodeType, number> = { input: 0, effect: 1, merge: 2, generator: 0, output: 1 };

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
  if (!target || from === to || target.type === "input" || target.type === "generator" || slot >= INPUT_COUNT[target.type]) return null;
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
    else if (n.type === "output") v = get(n.inputs[0]);
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
