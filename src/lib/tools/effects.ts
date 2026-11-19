import { z } from "zod";
import { defineTool } from "./registry";
import { EasingName, num } from "./schema";
import { activeTimeline } from "../../model/convert";
import type { ProjectDoc } from "../../model/types";
import * as E from "../../timeline/engine";
import * as FX from "../../timeline/effects";
import { getEffect, getTransition, listEffects, listTransitions } from "../effects";

/**
 * Effect and transition tools (phase 17), for the in-app chat and the MCP server. Clips are referred to by id
 * (get_project / the project summary lists them). Every call is one undo step; locked tracks are never changed.
 */

const ids = z.union([z.string(), z.array(z.string())]).transform((v) => (Array.isArray(v) ? v : [v])).describe("clip id or list of clip ids");
const tl = (doc: ProjectDoc) => activeTimeline(doc);
const on = (doc: ProjectDoc, fn: Parameters<typeof E.onActive>[1]) => E.onActive(doc, fn);

const effectNames = () => listEffects().map((e) => `${e.id} (${e.params.map((p) => p.key).join(", ") || "no params"})`).join("; ");
const transitionNames = () => listTransitions().map((t) => t.id).join(", ");

/** "drop shadow", "Chroma Key", "dropShadow" -> "drop-shadow". */
const tidyId = (v: unknown) => (typeof v === "string" ? v.trim().replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase().replace(/[\s_]+/g, "-") : v);

export const addEffectTool = defineTool({
  name: "add_effect",
  group: "timeline",
  description: "Add an effect to video or image clips (applied after the effects they already have).",
  hint: "",
  params: z.object({ clips: ids, effect: z.string().min(1), params: z.record(z.string(), z.unknown()).optional() }),
  normalize: (a) => (a && typeof a === "object" ? { ...(a as object), effect: tidyId((a as { effect?: unknown; type?: unknown }).effect ?? (a as { type?: unknown }).type) } : a),
  applyDoc: (doc, a) => {
    if (!getEffect(a.effect)) throw new Error(`no effect "${a.effect}". Effects: ${effectNames()}`);
    const targets = FX.effectTargets(tl(doc), doc, a.clips);
    if (!targets.length) throw new Error("none of those clips can take a picture effect (video or image clips on unlocked tracks)");
    return { doc: on(doc, (t) => FX.addEffect(t, targets, a.effect, a.params ?? {})), summary: `${getEffect(a.effect)!.name} added to ${targets.length} clip(s)` };
  },
});
// the effect list is known only after the registry has loaded; fill the hint lazily
Object.defineProperty(addEffectTool, "hint", { get: () => `effects: ${effectNames()}` });

export const setEffectTool = defineTool({
  name: "set_effect",
  group: "timeline",
  description: "Change an effect on a clip: its params, or switch it on or off. effect = the effect's id in the clip's stack, or its type (the first one of that type).",
  params: z.object({ clip: z.string(), effect: z.string(), params: z.record(z.string(), z.unknown()).optional(), enabled: z.boolean().optional() }),
  applyDoc: (doc, a) => {
    const c = tl(doc).clips.find((x) => x.id === a.clip);
    if (!c) throw new Error(`no clip ${a.clip}`);
    const fx = c.effects.find((e) => e.id === a.effect) ?? c.effects.find((e) => e.type === tidyId(a.effect));
    if (!fx) throw new Error(`clip ${a.clip} has no effect "${a.effect}". Its effects: ${c.effects.map((e) => `${e.id} (${e.type})`).join(", ") || "none"}`);
    return { doc: on(doc, (t) => FX.updateEffect(t, c.id, fx.id, { params: a.params, enabled: a.enabled })), summary: `${fx.type} on ${c.id} updated` };
  },
});

export const removeEffectTool = defineTool({
  name: "remove_effect",
  group: "timeline",
  description: "Remove an effect from a clip (by its id in the stack, or by type), or all effects with all: true.",
  params: z.object({ clip: z.string(), effect: z.string().optional(), all: z.boolean().default(false) }),
  applyDoc: (doc, a) => {
    const c = tl(doc).clips.find((x) => x.id === a.clip);
    if (!c) throw new Error(`no clip ${a.clip}`);
    if (a.all) return { doc: on(doc, (t) => FX.applyStackTo(t, [c.id], [])), summary: `all effects removed from ${c.id}` };
    const fx = c.effects.find((e) => e.id === a.effect) ?? c.effects.find((e) => e.type === tidyId(a.effect));
    if (!fx) throw new Error(`clip ${a.clip} has no effect "${a.effect}"`);
    return { doc: on(doc, (t) => FX.removeEffect(t, c.id, fx.id)), summary: `${fx.type} removed from ${c.id}` };
  },
});

export const addTransitionTool = defineTool({
  name: "add_transition",
  group: "timeline",
  description:
    "Add a transition between two touching clips on a track (from = the clip before the cut, to = the clip after), or at one clip's edge (only from: out at its end; only to: in at its start). Linked sound gets a crossfade. all_cuts: true adds it at every cut on from's track.",
  params: z.object({
    type: z.string().min(1),
    from: z.string().optional(),
    to: z.string().optional(),
    duration: num(0.04, 10).default(0.5),
    align: z.enum(["start", "center", "end"]).default("center"),
    easing: EasingName.optional(),
    all_cuts: z.boolean().default(false),
  }),
  normalize: (a) => (a && typeof a === "object" ? { ...(a as object), type: tidyId((a as { type?: unknown }).type) } : a),
  applyDoc: (doc, a) => {
    if (!getTransition(a.type)) throw new Error(`no transition "${a.type}". Transitions: ${transitionNames()}`);
    const t0 = tl(doc);
    const ref = t0.clips.find((x) => x.id === (a.from ?? a.to));
    if (!ref) throw new Error("give from and/or to (clip ids from the project summary)");
    let next = doc;
    let count = 0;
    const add = (from?: string, to?: string) => {
      next = on(next, (t) => FX.addTransition(t, { trackId: ref.trackId, from, to, type: a.type, duration: a.duration, align: a.align }));
      count++;
    };
    if (a.all_cuts) {
      const clips = E.clipsOn(t0, ref.trackId);
      clips.forEach((c, i) => {
        const n = clips[i + 1];
        if (n && Math.abs(c.start + c.duration - n.start) < 0.05) add(c.id, n.id);
      });
      if (!count) throw new Error("there are no touching clips on that track");
    } else {
      const to = a.to && t0.clips.find((x) => x.id === a.to);
      if (a.to && !to) throw new Error(`no clip ${a.to}`);
      add(a.from, a.to);
    }
    if (a.easing) {
      const trs = activeTimeline(next).cutTransitions ?? [];
      next = on(next, (t) => trs.reduce((acc, tr) => (tr.type === a.type ? FX.updateTransition(acc, tr.id, { easing: a.easing }) : acc), t));
    }
    return { doc: next, summary: `${getTransition(a.type)!.name} added${count > 1 ? ` at ${count} cuts` : ""}` };
  },
});
Object.defineProperty(addTransitionTool, "hint", { get: () => `type one of ${transitionNames()}; align start | center | end` });

export const removeTransitionTool = defineTool({
  name: "remove_transition",
  group: "timeline",
  description: "Remove a transition by its id, or the transitions touching a clip.",
  params: z.object({ id: z.string().optional(), clip: z.string().optional() }),
  applyDoc: (doc, a) => {
    const list = tl(doc).cutTransitions ?? [];
    const gone = list.filter((x) => (a.id && x.id === a.id) || (a.clip && (x.from === a.clip || x.to === a.clip)));
    if (!gone.length) throw new Error("no matching transition");
    return { doc: on(doc, (t) => gone.reduce((acc, g) => FX.removeTransition(acc, g.id), t)), summary: `${gone.length} transition(s) removed` };
  },
});

export const effectTools = [addEffectTool, setEffectTool, removeEffectTool, addTransitionTool, removeTransitionTool];
