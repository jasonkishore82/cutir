import { create } from "zustand";
import { registerEffect, unregisterEffect } from "../lib/effects";
import { register, unregister } from "../lib/commands/registry";
import { effectFromPlugin, effectId } from "../lib/plugins/host";
import { validatePlugin, type Plugin } from "../lib/plugins/manifest";
import { runScript } from "../lib/scripting/run";
import { realHost } from "../lib/scripting/host";
import { useDeliver } from "./deliver";

/**
 * Installed plugins (phase 30). The manifests live in localStorage and are registered again at start. Installing
 * needs no change to the app: effects join the effect registry, presets the delivery presets, scripts the palette.
 */

const KEY = "cutir:plugins";
const read = (): Plugin[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return (Array.isArray(raw) ? raw : []).map((p) => validatePlugin(p).plugin).filter((p): p is Plugin => !!p);
  } catch {
    return [];
  }
};
const write = (list: Plugin[]) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
};

const scriptId = (p: Plugin, sid: string) => `plugin.${p.id}.${sid}`;

function activate(p: Plugin) {
  for (const e of p.effects) registerEffect(effectFromPlugin(p, e));
  for (const pr of p.presets) useDeliver.getState().savePreset(pr);
  register(...p.scripts.map((s) => ({ id: scriptId(p, s.id), title: `${p.name}: ${s.title}`, category: "Tools" as const, keywords: "plugin script", run: async () => void (await usePlugins.getState().run(s.code, s.title)) })));
}
function deactivate(p: Plugin) {
  for (const e of p.effects) unregisterEffect(effectId(p, e));
  for (const pr of p.presets) useDeliver.getState().deletePreset(pr.id);
  unregister(...p.scripts.map((s) => scriptId(p, s.id)));
}

export type ConsoleLine = { kind: "in" | "out" | "err"; text: string };

type State = {
  list: Plugin[];
  console: ConsoleLine[];
  running: boolean;
  /** Install from the text of a plugin file. Replaces an installed plugin with the same id. */
  install: (text: string) => { ok: boolean; errors: string[]; plugin?: Plugin };
  remove: (id: string) => void;
  /** Register everything installed (called once at start). */
  start: () => void;
  run: (code: string, label?: string) => Promise<void>;
  clearConsole: () => void;
};

export const usePlugins = create<State>((set, get) => ({
  list: [],
  console: [],
  running: false,
  install: (text) => {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, errors: ["This file is not valid JSON."] };
    }
    const { plugin, errors } = validatePlugin(raw);
    if (!plugin) return { ok: false, errors };
    const old = get().list.find((p) => p.id === plugin.id);
    if (old) deactivate(old);
    activate(plugin);
    const list = [...get().list.filter((p) => p.id !== plugin.id), plugin];
    write(list);
    set({ list });
    return { ok: true, errors: [], plugin };
  },
  remove: (id) => {
    const p = get().list.find((x) => x.id === id);
    if (!p) return;
    deactivate(p);
    const list = get().list.filter((x) => x.id !== id);
    write(list);
    set({ list });
  },
  start: () => {
    const list = read();
    for (const p of list) activate(p);
    set({ list });
  },
  run: async (code, label) => {
    if (get().running) return;
    const push = (l: ConsoleLine) => set((s) => ({ console: [...s.console, l].slice(-200) }));
    set({ running: true });
    push({ kind: "in", text: label ?? code });
    const r = await runScript(code, realHost((t) => push({ kind: "out", text: t })));
    if (r.ok) {
      if (r.result !== null && r.result !== undefined) push({ kind: "out", text: typeof r.result === "string" ? r.result : JSON.stringify(r.result) });
    } else push({ kind: "err", text: r.error ?? "The script failed." });
    set({ running: false });
  },
  clearConsole: () => set({ console: [] }),
}));
