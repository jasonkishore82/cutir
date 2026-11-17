import { z } from "zod";
import { defineTool } from "./registry";
import { Position, color, idx, num } from "./schema";
import { lineAt } from "./helpers";
import { addLayer, findLayer, moveLineToLayer, removeLayer, updateLayer, updateLayerStyle } from "../../store/layers";
import type { Project, TextStyle } from "../../store/project";

const layerRef = z.union([z.string(), z.number()]).describe("layer name or number");

function need(p: Project, ref: string | number) {
  const layer = findLayer(p, ref);
  if (!layer) throw new Error(`layer "${ref}" does not exist (layers: ${p.layers.map((l, i) => `${i + 1} ${l.name}`).join(", ")})`);
  return layer;
}

const styleFields = {
  position: Position.optional(),
  fontSize: num(8, 400).optional(),
  color: color.optional(),
};

const pickStyle = (a: { position?: TextStyle["position"]; fontSize?: number; color?: string }): Partial<TextStyle> => {
  const out: Partial<TextStyle> = {};
  if (a.position) out.position = a.position;
  if (a.fontSize !== undefined) out.fontSize = a.fontSize;
  if (a.color) out.color = a.color;
  return out;
};

export const addLayerTool = defineTool({
  name: "add_layer",
  group: "layers",
  description: "Add a new text layer (an extra lane on the timeline, drawn above the others). Optional name and style.",
  params: z.object({ name: z.string().min(1).optional(), ...styleFields }),
  apply: (p, a) => {
    if (p.layers.length >= 8) throw new Error("up to 8 layers");
    const r = addLayer(p, a.name, pickStyle(a));
    return { project: r.project, summary: `layer ${r.project.layers.length} added: ${r.layer.name}` };
  },
});

export const updateLayerTool = defineTool({
  name: "update_layer",
  group: "layers",
  description: "Change a layer: rename it, show/hide, lock, or set its position, fontSize and color.",
  params: z
    .object({
      layer: layerRef,
      name: z.string().min(1).optional(),
      visible: z.boolean().optional(),
      locked: z.boolean().optional(),
      ...styleFields,
    })
    .refine((a) => a.name !== undefined || a.visible !== undefined || a.locked !== undefined || Object.keys(pickStyle(a)).length > 0, "provide something to change"),
  apply: (p, a) => {
    const layer = need(p, a.layer);
    let next = updateLayer(p, layer.id, {
      ...(a.name !== undefined && { name: a.name }),
      ...(a.visible !== undefined && { visible: a.visible }),
      ...(a.locked !== undefined && { locked: a.locked }),
    });
    const style = pickStyle(a);
    if (Object.keys(style).length) next = updateLayerStyle(next, layer.id, style);
    return { project: next, summary: `layer ${layer.name} updated` };
  },
});

export const deleteLayerTool = defineTool({
  name: "delete_layer",
  group: "layers",
  description: "Delete a layer and the lines on it.",
  params: z.object({ layer: layerRef }),
  apply: (p, a) => {
    const layer = need(p, a.layer);
    return { project: removeLayer(p, layer.id), summary: `layer ${layer.name} deleted` };
  },
});

export const moveLineTool = defineTool({
  name: "move_line",
  group: "layers",
  description: "Move a line (1-based index) to another layer.",
  params: z.object({ index: idx, layer: layerRef }),
  apply: (p, a) => {
    const line = lineAt(p, a.index);
    const layer = need(p, a.layer);
    return { project: moveLineToLayer(p, line.id, layer.id), summary: `line ${a.index} moved to ${layer.name}` };
  },
});

export const layerTools = [addLayerTool, updateLayerTool, deleteLayerTool, moveLineTool];
