import { useRef, useState } from "react";
import { Card } from "./ui";
import { useProject } from "../store/project";
import { activeTimeline } from "../model/convert";
import { editTimeline, useTimelineUi } from "../timeline/ui";
import { getEffect, listEffects } from "../lib/effects";
import { DEFAULT_TEXT, DEFAULT_TRANSFORM, INPUT_COUNT, addNode, connect, disconnect, graphToStack, groupNodes, isLinear, removeNode, stackToGraph, ungroup, validateGraph, type Graph, type GraphNode } from "../lib/graph/graph";
import type { BlendMode, Clip } from "../model/types";
import { ParamField } from "./EffectsPanel";

const btn = "rounded-md border border-edge px-2 py-0.5 text-[11px] text-gray-300 hover:bg-white/10 disabled:opacity-40";
const NW = 112;
const NH = 40;
const MODES: BlendMode[] = ["normal", "add", "multiply", "screen", "overlay", "softlight", "hardlight", "darken", "lighten", "dodge", "burn", "difference", "exclusion"];
const COLORS: Record<GraphNode["type"], string> = { input: "#22c55e", effect: "#60a5fa", merge: "#f59e0b", generator: "#c084fc", output: "#f43f5e", transform: "#2dd4bf", mask: "#fb923c", text: "#e879f9", group: "#a3a3a3" };

/** The selected clip's node graph (phase 22): the effect stack as a graph, with merges and generators that a stack cannot hold. */
export default function GraphCard() {
  const doc = useProject((s) => s.doc);
  const selected = useTimelineUi((s) => s.selected);
  const tl = activeTimeline(doc);
  const clip = selected.length === 1 ? tl.clips.find((c) => c.id === selected[0]) : undefined;
  const media = doc.media.find((m) => m.id === clip?.mediaId);
  if (!clip || clip.fill || !(media?.kind === "video" || media?.kind === "image" || clip.generator)) return null;
  return <Editor clip={clip} />;
}

function Editor({ clip }: { clip: Clip }) {
  const g = clip.graph;
  const [sel, setSel] = useState<string | null>(null);
  /** Other nodes picked with Shift, to be grouped with the selected one. */
  const [more, setMore] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [wire, setWire] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ kind: "node"; id: string; dx: number; dy: number } | { kind: "pan"; x: number; y: number } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const setGraph = (next: Graph | undefined, key?: string) => editTimeline((t) => ({ ...t, clips: t.clips.map((c) => (c.id === clip.id ? { ...c, graph: next } : c)) }), key);

  if (!g) {
    return (
      <Card title="Node graph" hint="The same effects as a graph: add merges and generators, blend branches, preview from any node.">
        <button className={btn} onClick={() => setGraph(stackToGraph(clip.effects))}>Edit as a node graph</button>
      </Card>
    );
  }

  const errs = validateGraph(g);
  const linear = isLinear(g);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const node = sel ? byId.get(sel) : undefined;
  const patchNode = (id: string, p: Partial<GraphNode>, key?: string) => setGraph({ ...g, nodes: g.nodes.map((n) => (n.id === id ? { ...n, ...p } : n)) }, key);
  const at = (e: React.PointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.x) / view.k, y: (e.clientY - r.top - view.y) / view.k };
  };
  const inPort = (n: GraphNode, i: number) => ({ x: n.x, y: n.y + (NH * (i + 1)) / (INPUT_COUNT[n.type] + 1) });
  const outPort = (n: GraphNode) => ({ x: n.x + NW, y: n.y + NH / 2 });
  const maxY = Math.max(...g.nodes.map((n) => n.y)) + NH + 20;
  const maxX = Math.max(...g.nodes.map((n) => n.x)) + NW + 20;

  const back = () => {
    const stack = graphToStack(g);
    if (!stack) return;
    editTimeline((t) => ({ ...t, clips: t.clips.map((c) => (c.id === clip.id ? { ...c, graph: undefined, effects: stack } : c)) }));
  };

  return (
    <Card title="Node graph" hint="Drag nodes to move them, click an output dot then an input dot to connect, select a node to edit it. The viewer shows the output node, or the one marked Preview.">
      <div className="flex flex-wrap gap-1">
        <select className="field !w-auto !py-0.5 text-[11px]" value="" onChange={(e) => e.target.value && setGraph(addNode(g, { type: "effect", name: getEffect(e.target.value)?.name ?? e.target.value, effect: { type: e.target.value, params: Object.fromEntries(getEffect(e.target.value)!.params.map((s) => [s.key, structuredClone(s.default)])) } }))} aria-label="Add an effect node">
          <option value="">+ Effect</option>
          {listEffects().map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        <button className={btn} onClick={() => setGraph(addNode(g, { type: "merge", name: "Merge", merge: { mode: "normal", opacity: 1 } }))}>+ Merge</button>
        <button className={btn} onClick={() => setGraph(addNode(g, { type: "generator", name: "Solid", generator: { type: "solid", color: "#ff3366" } }))}>+ Solid</button>
        <button className={btn} onClick={() => setGraph(addNode(g, { type: "transform", name: "Transform", transform: { ...DEFAULT_TRANSFORM } }))}>+ Transform</button>
        <button className={btn} onClick={() => setGraph(addNode(g, { type: "mask", name: "Mask", mask: { params: { shape: "ellipse" } } }))}>+ Mask</button>
        <button className={btn} onClick={() => setGraph(addNode(g, { type: "text", name: "Text", text: { ...DEFAULT_TEXT } }))}>+ Text</button>
        <button className={btn} onClick={() => setView({ x: 0, y: 0, k: 1 })}>Reset view</button>
        <button className={btn} disabled={!linear} title={linear ? "Back to the plain effect stack" : "Only a single chain from input to output fits a stack"} onClick={back}>Back to stack</button>
      </div>
      <svg
        ref={svg}
        className="h-48 w-full touch-none rounded-md border border-edge bg-black/30"
        onWheel={(e) => setView((v) => ({ ...v, k: Math.max(0.4, Math.min(2.5, v.k * (e.deltaY < 0 ? 1.1 : 0.9))) }))}
        onPointerDown={(e) => {
          if ((e.target as Element).closest("[data-node]")) return;
          drag.current = { kind: "pan", x: e.clientX - view.x, y: e.clientY - view.y };
          setSel(null);
          setWire(null);
          (e.target as Element).setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          if (d.kind === "pan") setView((v) => ({ ...v, x: e.clientX - d.x, y: e.clientY - d.y }));
          else {
            const p = at(e);
            patchNode(d.id, { x: Math.round(p.x - d.dx), y: Math.round(p.y - d.dy) }, `gn:${d.id}`);
          }
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        role="group"
        aria-label="Node graph editor"
      >
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {g.nodes.flatMap((n) =>
            n.inputs.map((from, i) => {
              const f = from ? byId.get(from) : undefined;
              if (!f) return null;
              const a = outPort(f);
              const b = inPort(n, i);
              const mx = (a.x + b.x) / 2;
              return <path key={`${n.id}:${i}`} d={`M${a.x} ${a.y} C${mx} ${a.y} ${mx} ${b.y} ${b.x} ${b.y}`} fill="none" stroke="#94a3b8" strokeWidth={1.5} onDoubleClick={() => setGraph(disconnect(g, n.id, i))} />;
            })
          )}
          {g.nodes.map((n) => (
            <g key={n.id} data-node transform={`translate(${n.x} ${n.y})`} opacity={n.bypass ? 0.45 : 1}>
              <rect
                width={NW}
                height={NH}
                rx={6}
                fill="#14141c"
                stroke={sel === n.id || more.includes(n.id) ? "#facc15" : g.preview === n.id ? "#38bdf8" : COLORS[n.type]}
                strokeWidth={sel === n.id || g.preview === n.id ? 2.2 : 1.4}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  if (e.shiftKey && sel && sel !== n.id) setMore((m) => (m.includes(n.id) ? m.filter((x) => x !== n.id) : [...m, n.id]));
                  else (setSel(n.id), setMore([]));
                  const p = at(e);
                  drag.current = { kind: "node", id: n.id, dx: p.x - n.x, dy: p.y - n.y };
                  (e.target as Element).setPointerCapture?.(e.pointerId);
                }}
              />
              <text x={8} y={17} fontSize={10} fill="#e5e7eb" pointerEvents="none">{(n.name ?? n.type).slice(0, 16)}</text>
              <text x={8} y={31} fontSize={8} fill="#9ca3af" pointerEvents="none">{n.type}{n.bypass ? " (bypassed)" : ""}</text>
              {Array.from({ length: INPUT_COUNT[n.type] }, (_, i) => (
                <circle key={i} cx={0} cy={(NH * (i + 1)) / (INPUT_COUNT[n.type] + 1)} r={5} fill={n.inputs[i] ? "#94a3b8" : "#0b0b0f"} stroke="#94a3b8" onPointerDown={(e) => {
                  e.stopPropagation();
                  if (wire) {
                    const next = connect(g, wire, n.id, i);
                    if (next) setGraph(next);
                    setWire(null);
                  }
                }} />
              ))}
              {n.type !== "output" && (
                <circle cx={NW} cy={NH / 2} r={5} fill={wire === n.id ? "#facc15" : "#0b0b0f"} stroke={COLORS[n.type]} onPointerDown={(e) => {
                  e.stopPropagation();
                  setWire(wire === n.id ? null : n.id);
                }} />
              )}
            </g>
          ))}
          <rect x={0} y={0} width={maxX} height={maxY} fill="none" pointerEvents="none" />
        </g>
      </svg>
      {note && <p className="text-[11px] text-yellow-300" role="status">{note}</p>}
      {wire && <p className="text-[11px] text-yellow-300" role="status">Click an input dot to connect {byId.get(wire)?.name ?? wire}.</p>}
      {errs.map((e) => <p key={e} className="text-[11px] text-red-300" role="alert">{e}</p>)}
      {node && (
        <div className="space-y-2 rounded-md bg-black/20 p-2">
          <div className="flex flex-wrap items-center gap-1 text-[12px] text-gray-200">
            <input className="field !w-32 !py-0.5 text-[11px]" value={node.name ?? ""} onChange={(e) => patchNode(node.id, { name: e.target.value }, `gname:${node.id}`)} aria-label="Node name" />
            {node.type !== "input" && node.type !== "output" && <button className={btn} aria-pressed={!!node.bypass} onClick={() => patchNode(node.id, { bypass: !node.bypass || undefined })}>{node.bypass ? "Enable" : "Bypass"}</button>}
            <button className={btn} aria-pressed={g.preview === node.id} onClick={() => setGraph({ ...g, preview: g.preview === node.id ? null : node.id })}>{g.preview === node.id ? "Stop preview" : "Preview here"}</button>
            {node.type !== "input" && node.type !== "output" && <button className={btn} onClick={() => (setSel(null), setGraph(removeNode(g, node.id)))}>Delete</button>}
            {node.type !== "input" && node.type !== "output" && node.type !== "group" && (
              <button className={btn} title="Shift-click other nodes first to group several" onClick={() => {
                const r = groupNodes(g, [node.id, ...more]);
                if ("error" in r) return setNote(r.error);
                setNote("");
                setMore([]);
                setSel(null);
                setGraph(r.graph);
              }}>Group{more.length ? ` ${more.length + 1} nodes` : ""}</button>
            )}
            {node.type === "group" && <button className={btn} onClick={() => (setSel(null), setGraph(ungroup(g, node.id)))}>Ungroup</button>}
          </div>
          {node.type === "merge" && node.merge && (
            <div className="grid grid-cols-2 gap-2">
              <label className="block text-[11px] text-gray-400">Blend
                <select className="field" value={node.merge.mode} onChange={(e) => patchNode(node.id, { merge: { ...node.merge!, mode: e.target.value as BlendMode } })}>
                  {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </label>
              <label className="block text-[11px] text-gray-400">Opacity {Math.round(node.merge.opacity * 100)}%
                <input type="range" min={0} max={100} value={Math.round(node.merge.opacity * 100)} onChange={(e) => patchNode(node.id, { merge: { ...node.merge!, opacity: Number(e.target.value) / 100 } }, `gm:${node.id}`)} className="w-full" />
              </label>
              <p className="col-span-2 text-[10px] text-gray-500">Input 1 is the background, input 2 is laid over it.</p>
            </div>
          )}
          {node.type === "generator" && node.generator?.type === "solid" && (
            <label className="flex items-center justify-between text-[12px] text-gray-300">Colour
              <input type="color" value={node.generator.color} onChange={(e) => patchNode(node.id, { generator: { type: "solid", color: e.target.value } }, `gc:${node.id}`)} />
            </label>
          )}
          {node.type === "transform" && node.transform && (
            <div className="grid grid-cols-2 gap-2">
              {([["x", "Move across", -100, 100, 100], ["y", "Move down", -100, 100, 100], ["scale", "Scale", 5, 400, 100], ["rotation", "Turn", -360, 360, 1], ["opacity", "Opacity", 0, 100, 100]] as const).map(([k, label, lo, hi, f]) => (
                <label key={k} className="block text-[11px] text-gray-400">{label} {Math.round(node.transform![k] * f)}{k === "rotation" ? "°" : "%"}
                  <input type="range" min={lo} max={hi} value={Math.round(node.transform![k] * f)} onChange={(e) => patchNode(node.id, { transform: { ...node.transform!, [k]: Number(e.target.value) / f } }, `gt:${node.id}:${k}`)} className="w-full" />
                </label>
              ))}
            </div>
          )}
          {node.type === "text" && node.text && (
            <div className="space-y-1">
              <textarea className="field" rows={2} value={node.text.text} aria-label="Text" onChange={(e) => patchNode(node.id, { text: { ...node.text!, text: e.target.value } }, `gtx:${node.id}`)} />
              <div className="grid grid-cols-2 gap-2">
                <label className="flex items-center justify-between text-[12px] text-gray-300">Colour <input type="color" value={node.text.color} onChange={(e) => patchNode(node.id, { text: { ...node.text!, color: e.target.value } }, `gtc:${node.id}`)} /></label>
                <label className="block text-[11px] text-gray-400">Size {Math.round(node.text.size * 100)}%<input type="range" min={2} max={40} value={Math.round(node.text.size * 100)} onChange={(e) => patchNode(node.id, { text: { ...node.text!, size: Number(e.target.value) / 100 } }, `gts:${node.id}`)} className="w-full" /></label>
                <label className="block text-[11px] text-gray-400">Across {Math.round(node.text.x * 100)}%<input type="range" min={0} max={100} value={Math.round(node.text.x * 100)} onChange={(e) => patchNode(node.id, { text: { ...node.text!, x: Number(e.target.value) / 100 } }, `gtxx:${node.id}`)} className="w-full" /></label>
                <label className="block text-[11px] text-gray-400">Down {Math.round(node.text.y * 100)}%<input type="range" min={0} max={100} value={Math.round(node.text.y * 100)} onChange={(e) => patchNode(node.id, { text: { ...node.text!, y: Number(e.target.value) / 100 } }, `gtxy:${node.id}`)} className="w-full" /></label>
              </div>
            </div>
          )}
          {node.type === "mask" && node.mask && (
            <>
              <p className="text-[10px] text-gray-500">Connect a picture to the second input to use its alpha as the matte; otherwise the shape below cuts the picture.</p>
              {getEffect("mask")?.params.map((spec) => (
                <ParamField
                  key={spec.key}
                  spec={spec}
                  all={node.mask!.params}
                  value={node.mask!.params[spec.key]}
                  keys={node.mask!.keys?.[spec.key]}
                  now={0}
                  onChange={(v) => patchNode(node.id, { mask: { ...node.mask!, params: { ...node.mask!.params, [spec.key]: v } } }, `gm:${node.id}:${spec.key}`)}
                  onKeys={(keys) => patchNode(node.id, { mask: { ...node.mask!, keys: { ...(node.mask!.keys ?? {}), [spec.key]: keys } } })}
                />
              ))}
            </>
          )}
          {node.type === "group" && node.group && <p className="text-[11px] text-gray-400">{node.group.nodes.length - 2} nodes inside. Ungroup to edit them.</p>}
          {node.type === "effect" && node.effect && getEffect(node.effect.type)?.params.map((spec) => (
            <ParamField
              key={spec.key}
              spec={spec}
              all={node.effect!.params}
              value={node.effect!.params[spec.key]}
              keys={node.effect!.keys?.[spec.key]}
              now={0}
              onChange={(v) => patchNode(node.id, { effect: { ...node.effect!, params: { ...node.effect!.params, [spec.key]: v } } }, `gp:${node.id}:${spec.key}`)}
              onKeys={(keys) => patchNode(node.id, { effect: { ...node.effect!, keys: { ...(node.effect!.keys ?? {}), [spec.key]: keys } } })}
            />
          ))}
        </div>
      )}
      <p className="text-[11px] text-gray-500">{linear ? "This graph is a plain chain, so the Effects stack above shows the same effects." : "This graph branches, so it replaces the effect stack for this clip."}</p>
    </Card>
  );
}
