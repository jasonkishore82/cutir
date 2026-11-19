import {
  layerIdOf,
  orderByLayers,
  uid,
  type Layer,
  type LyricLine,
  type Project,
  type TextStyle,
} from "./project";

/**
 * Pure layer operations on a Project. The timeline UI and the AI tools both use these, so a layer behaves
 * the same whichever way it was changed.
 */

/** A new layer defaults to a smaller line at the bottom, so it does not sit on top of the main lyrics. */
export const DEFAULT_LAYER_STYLE: Partial<TextStyle> = { position: "bottom", fontSize: 56 };

export function uniqueLayerName(p: Project, base: string): string {
  const taken = new Set(p.layers.map((l) => l.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}

export function addLayer(p: Project, name?: string, style?: Partial<TextStyle>): { project: Project; layer: Layer } {
  const layer: Layer = {
    id: uid(),
    name: uniqueLayerName(p, name?.trim() || `Layer ${p.layers.length + 1}`),
    visible: true,
    locked: false,
    style: { ...DEFAULT_LAYER_STYLE, ...style },
  };
  return { project: { ...p, layers: [...p.layers, layer] }, layer };
}

export function updateLayer(p: Project, id: string, patch: Partial<Omit<Layer, "id">>): Project {
  return { ...p, layers: p.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)) };
}

export function updateLayerStyle(p: Project, id: string, patch: Partial<TextStyle>): Project {
  return { ...p, layers: p.layers.map((l) => (l.id === id ? { ...l, style: { ...l.style, ...patch } } : l)) };
}

/** Removes a layer and the lines on it. The last remaining layer cannot be removed. */
export function removeLayer(p: Project, id: string): Project {
  if (p.layers.length <= 1) throw new Error("A project needs at least one layer");
  if (!p.layers.some((l) => l.id === id)) throw new Error("that layer does not exist");
  const gone = (l: LyricLine) => layerIdOf(p, l) === id;
  const layers = p.layers.filter((l) => l.id !== id);
  // lines that fell back to "the first layer" must keep belonging to it after the first layer is removed
  const lines = p.lines.filter((l) => !gone(l));
  return orderByLayers({ ...p, layers, lines });
}

export function moveLayer(p: Project, id: string, dir: -1 | 1): Project {
  const i = p.layers.findIndex((l) => l.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= p.layers.length) return p;
  const base = orderByLayers(p); // pin every line to its layer BEFORE the order changes
  const layers = [...base.layers];
  [layers[i], layers[j]] = [layers[j], layers[i]];
  return orderByLayers({ ...base, layers });
}

export function moveLineToLayer(p: Project, lineId: string, layerId: string): Project {
  if (!p.layers.some((l) => l.id === layerId)) throw new Error("that layer does not exist");
  return orderByLayers({ ...p, lines: p.lines.map((l) => (l.id === lineId ? { ...l, layerId } : l)) });
}

/** Find a layer by 1-based number ("2") or by name ("translation"). */
export function findLayer(p: Project, ref: string | number): Layer | undefined {
  const s = String(ref).trim();
  if (/^\d+$/.test(s)) return p.layers[Number(s) - 1];
  const lower = s.toLowerCase();
  return p.layers.find((l) => l.name.toLowerCase() === lower) ?? p.layers.find((l) => l.name.toLowerCase().includes(lower));
}
