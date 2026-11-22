import { sanitizePreset, type DeliverPreset } from "../deliver/presets";
import type { EffectCategory, ParamSpec } from "../effects/types";

/**
 * Plugin manifests (phase 30). A plugin is plain JSON: no code runs on the page. What a plugin can add:
 *   effects   a GLSL fragment pass plus parameters (runs on the GPU only, in the browser's WebGL sandbox)
 *   presets   delivery presets (data)
 *   scripts   commands whose code runs in a sandboxed worker with no page access, only the `cutir` API
 * Each kind needs its permission in `permissions`, and the user sees the list before installing.
 */

export const PLUGIN_API = 1;
export type Permission = "effects" | "presets" | "scripts";
export const PERMISSIONS: Permission[] = ["effects", "presets", "scripts"];

export type PluginEffect = {
  id: string;
  name: string;
  category: EffectCategory;
  description: string;
  params: ParamSpec[];
  /** GLSL ES 3.00 fragment body; see docs/PLUGINS.md for the uniforms. */
  glsl: string;
};
export type PluginScript = { id: string; title: string; code: string };

export type Plugin = {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  api: number;
  permissions: Permission[];
  effects: PluginEffect[];
  presets: DeliverPreset[];
  scripts: PluginScript[];
};

const CATEGORIES: EffectCategory[] = ["Transform", "Blur and sharpen", "Colour", "Stylize", "Keying", "Distort", "Animation"];
const ID = /^[a-z][a-z0-9-]{1,40}$/;
const KEY = /^[a-z][a-zA-Z0-9]{0,23}$/;
export const MAX_GLSL = 20000;
export const MAX_SCRIPT = 50000;

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);

/** The uniform a param arrives as in the shader. The runner types them by prefix: uCol vec3, uPt vec2, the rest float. */
export const uniformName = (p: { key: string; type: string }) => (p.type === "color" ? `uCol_${p.key}` : p.type === "point" ? `uPt_${p.key}` : `u_${p.key}`);

function cleanParam(raw: unknown, errors: string[], where: string): ParamSpec | null {
  const r = raw as Record<string, unknown>;
  if (!r || typeof r !== "object") return null;
  const key = str(r.key, 24);
  const label = str(r.label, 40) || key;
  if (!KEY.test(key)) return void errors.push(`${where}: parameter key "${key}" must start with a lowercase letter and use letters and digits only`), null;
  switch (r.type) {
    case "number": {
      if (![r.min, r.max, r.default].every(finite)) return void errors.push(`${where}.${key}: number needs min, max and default`), null;
      const min = r.min as number, max = r.max as number;
      if (min >= max) return void errors.push(`${where}.${key}: min must be below max`), null;
      return { key, label, type: "number", min, max, default: Math.min(max, Math.max(min, r.default as number)), ...(finite(r.step) ? { step: r.step as number } : {}), ...(typeof r.unit === "string" ? { unit: r.unit.slice(0, 6) } : {}) };
    }
    case "angle":
      return { key, label, type: "angle", default: finite(r.default) ? (r.default as number) : 0 };
    case "boolean":
      return { key, label, type: "boolean", default: r.default === true };
    case "color":
      return { key, label, type: "color", default: typeof r.default === "string" && /^#[0-9a-f]{6}$/i.test(r.default) ? r.default : "#ffffff" };
    case "point": {
      const d = r.default as { x?: unknown; y?: unknown } | undefined;
      return { key, label, type: "point", default: { x: finite(d?.x) ? (d!.x as number) : 0.5, y: finite(d?.y) ? (d!.y as number) : 0.5 } };
    }
    case "choice": {
      const opts = Array.isArray(r.options) ? r.options.map((o) => ({ value: str((o as { value?: unknown })?.value, 30), label: str((o as { label?: unknown })?.label, 40) })).filter((o) => o.value) : [];
      if (opts.length < 2) return void errors.push(`${where}.${key}: a choice needs at least two options`), null;
      return { key, label, type: "choice", options: opts.map((o) => ({ value: o.value, label: o.label || o.value })), default: opts.some((o) => o.value === r.default) ? (r.default as string) : opts[0].value };
    }
    default:
      return void errors.push(`${where}.${key}: parameter type "${String(r.type)}" is not supported in plugins`), null;
  }
}

/** Check a manifest. Returns the cleaned plugin, or null with every problem found, in plain words. */
export function validatePlugin(raw: unknown): { plugin: Plugin | null; errors: string[] } {
  const errors: string[] = [];
  const r = raw as Record<string, unknown>;
  if (!r || typeof r !== "object" || Array.isArray(r)) return { plugin: null, errors: ["This is not a plugin file (expected a JSON object)."] };
  const id = str(r.id, 41);
  if (!ID.test(id)) errors.push(`id "${id}" must be lowercase letters, digits and dashes, 2 to 41 characters, starting with a letter`);
  const name = str(r.name, 60);
  if (!name) errors.push("name is missing");
  if (r.api !== PLUGIN_API) errors.push(`this plugin is for plugin API ${String(r.api)}; this Cutir supports API ${PLUGIN_API}`);
  const version = str(r.version, 20) || "0.0.0";
  const permissions = Array.isArray(r.permissions) ? PERMISSIONS.filter((p) => (r.permissions as unknown[]).includes(p)) : [];
  const unknownPerm = Array.isArray(r.permissions) ? (r.permissions as unknown[]).filter((p) => !PERMISSIONS.includes(p as Permission)) : [];
  for (const p of unknownPerm) errors.push(`unknown permission "${String(p)}"`);

  const effects: PluginEffect[] = [];
  const rawEffects = Array.isArray(r.effects) ? r.effects : [];
  if (rawEffects.length && !permissions.includes("effects")) errors.push('the plugin has effects but does not declare the "effects" permission');
  const seen = new Set<string>();
  for (const [i, e0] of rawEffects.entries()) {
    const e = e0 as Record<string, unknown>;
    const where = `effects[${i}]`;
    const eid = str(e?.id, 41);
    if (!ID.test(eid)) {
      errors.push(`${where}: id "${eid}" must be lowercase letters, digits and dashes`);
      continue;
    }
    if (seen.has(eid)) errors.push(`${where}: id "${eid}" is used twice`);
    seen.add(eid);
    const glsl = typeof e.glsl === "string" ? e.glsl : "";
    if (!glsl.includes("main")) errors.push(`${where}: glsl needs a void main()`);
    if (glsl.length > MAX_GLSL) errors.push(`${where}: glsl is longer than ${MAX_GLSL} characters`);
    if (/#\s*(extension|include)/.test(glsl)) errors.push(`${where}: glsl may not use #extension or #include`);
    const params: ParamSpec[] = [];
    const keys = new Set<string>();
    for (const p of Array.isArray(e.params) ? e.params : []) {
      const c = cleanParam(p, errors, where);
      if (!c) continue;
      if (keys.has(c.key)) errors.push(`${where}: parameter "${c.key}" is used twice`);
      keys.add(c.key);
      params.push(c);
    }
    effects.push({ id: eid, name: str(e.name, 60) || eid, category: CATEGORIES.includes(e.category as EffectCategory) ? (e.category as EffectCategory) : "Stylize", description: str(e.description, 200), params, glsl });
  }

  const presets: DeliverPreset[] = [];
  const rawPresets = Array.isArray(r.presets) ? r.presets : [];
  if (rawPresets.length && !permissions.includes("presets")) errors.push('the plugin has presets but does not declare the "presets" permission');
  for (const [i, p] of rawPresets.entries()) {
    const c = sanitizePreset(p, `p${i}`);
    if (!c) errors.push(`presets[${i}]: not a valid preset (it needs a name)`);
    else presets.push({ ...c, id: `plugin-${id}-${str((p as { id?: unknown }).id, 30) || i}`.replace(/[^\w-]/g, "-") });
  }

  const scripts: PluginScript[] = [];
  const rawScripts = Array.isArray(r.scripts) ? r.scripts : [];
  if (rawScripts.length && !permissions.includes("scripts")) errors.push('the plugin has scripts but does not declare the "scripts" permission');
  for (const [i, s0] of rawScripts.entries()) {
    const s = s0 as Record<string, unknown>;
    const sid = str(s?.id, 41);
    const code = typeof s?.code === "string" ? s.code : "";
    if (!ID.test(sid)) errors.push(`scripts[${i}]: id "${sid}" must be lowercase letters, digits and dashes`);
    else if (!code.trim()) errors.push(`scripts[${i}]: code is empty`);
    else if (code.length > MAX_SCRIPT) errors.push(`scripts[${i}]: code is longer than ${MAX_SCRIPT} characters`);
    else scripts.push({ id: sid, title: str(s.title, 60) || sid, code });
  }

  if (!effects.length && !presets.length && !scripts.length && !errors.length) errors.push("the plugin adds nothing (no effects, presets or scripts)");
  if (errors.length) return { plugin: null, errors };
  return { plugin: { id, name, version, author: str(r.author, 60), description: str(r.description, 300), api: PLUGIN_API, permissions, effects, presets, scripts }, errors: [] };
}

/** What installing asks the user to accept, one line per thing. */
export function permissionSummary(p: Plugin): string[] {
  const out: string[] = [];
  if (p.effects.length) out.push(`Adds ${p.effects.length} effect${p.effects.length === 1 ? "" : "s"} that run on the graphics card only: ${p.effects.map((e) => e.name).join(", ")}.`);
  if (p.presets.length) out.push(`Adds ${p.presets.length} delivery preset${p.presets.length === 1 ? "" : "s"}.`);
  if (p.scripts.length) out.push(`Adds ${p.scripts.length} script command${p.scripts.length === 1 ? "" : "s"} that can edit this project through the scripting API (undoable): ${p.scripts.map((s) => s.title).join(", ")}. They run in a sandboxed worker with no access to the page, your files or the app's storage; install only scripts you trust.`);
  return out;
}
