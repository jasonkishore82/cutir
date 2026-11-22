import type { EffectDef, Params } from "../effects/types";
import { rgb } from "../effects/gpu";
import type { Plugin, PluginEffect } from "./manifest";
import { uniformName } from "./manifest";

/** An effect id in the registry is "<plugin>-<effect>", so a plugin cannot clash with a built-in effect. */
export const effectId = (plugin: Pick<Plugin, "id">, e: Pick<PluginEffect, "id">) => `${plugin.id}-${e.id}`;

/** Turn a plugin's effect into an EffectDef the registry accepts. */
export function effectFromPlugin(plugin: Plugin, pe: PluginEffect): EffectDef {
  return {
    id: effectId(plugin, pe),
    name: pe.name,
    category: pe.category,
    description: pe.description || `${pe.name} (plugin: ${plugin.name})`,
    params: pe.params,
    // no CPU version: without WebGL2 the clip passes through untouched
    render: (src, dst) => dst.ctx.drawImage(src.canvas as CanvasImageSource, 0, 0),
    gpu: {
      fragment: pe.glsl,
      uniforms: (p: Params) => {
        const out: Record<string, number | number[]> = {};
        for (const s of pe.params) {
          const v = p[s.key] ?? s.default;
          const name = uniformName(s);
          if (s.type === "color") out[name] = rgb(v);
          else if (s.type === "point") out[name] = [Number((v as { x: number }).x) || 0, Number((v as { y: number }).y) || 0];
          else if (s.type === "boolean") out[name] = v ? 1 : 0;
          else if (s.type === "choice") out[name] = Math.max(0, s.options.findIndex((o) => o.value === v));
          else out[name] = Number(v) || 0;
        }
        return out;
      },
    },
  };
}
