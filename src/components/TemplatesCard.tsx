import { useEffect, useState } from "react";
import { Card } from "./ui";
import { useTarget } from "./props";
import { readField } from "../lib/styleEdit";
import { ensureFont } from "../lib/fonts";
import {
  BUILTIN_TEMPLATES,
  applyTemplate,
  templateUnsets,
  templateWrites,
  deleteUserTemplate,
  loadUserTemplates,
  saveUserTemplate,
  templateFromLine,
  useTemplates,
  type Template,
} from "../lib/templates";
import { DEFAULT_STYLE, useProject } from "../store/project";

const getDefault = (path: string): unknown => path.split(".").reduce<unknown>((a, k) => (a == null ? undefined : (a as Record<string, unknown>)[k]), DEFAULT_STYLE);

const SCOPE_WORD = { line: "the selected lines", layer: "this layer", project: "the whole project" } as const;

/** Ready-made looks, applied to whatever the scope bar above points at. The user can save a line's look as their own. */
export default function TemplatesCard() {
  const { target, scope, ids, project } = useTarget();
  const user = useTemplates((s) => s.user);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // the template just picked, for this target; the highlight also follows the style itself, so it survives a reload
  const targetKey = `${scope}:${ids.join(",")}`;
  const [picked, setPicked] = useState<{ key: string; id: string } | null>(null);
  const matches = (t: Template) =>
    templateWrites(t).every(([path, v]) => {
      const r = readField(project, target, path);
      return !r.mixed && JSON.stringify(r.value) === JSON.stringify(v);
    }) &&
    // fields the template leaves out must be off or at their default, or this is not that template's look any more
    templateUnsets(t).every((path) => {
      if (path.startsWith("transform.")) return true;
      const r = readField(project, target, path);
      return !r.mixed && (r.value === undefined || JSON.stringify(r.value) === JSON.stringify(getDefault(path)));
    });
  const isActive = (t: Template) => (picked?.key === targetKey && picked.id === t.id) || matches(t);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => {
    void loadUserTemplates();
  }, []);

  const apply = async (t: Template) => {
    setBusy(t.id);
    setMsg(null);
    try {
      if (t.style.fontFamily) await ensureFont(t.style.fontFamily).catch(() => undefined); // offline: keep the look, the font falls back
      applyTemplate(target, t);
      setPicked({ key: targetKey, id: t.id });
      setMsg({ ok: true, text: `${t.name} applied to ${SCOPE_WORD[scope]}.` });
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    const t = templateFromLine(useProject.getState().project, ids[ids.length - 1], name);
    if (!t) return;
    await saveUserTemplate(t);
    setNaming(false);
    setName("");
    setMsg({ ok: true, text: `Saved "${t.name}" on this device.` });
  };

  const tile = "group relative rounded-lg border border-edge bg-black/20 px-2.5 py-2 text-left hover:border-accent/60 hover:bg-raised disabled:opacity-50";

  return (
    <Card title="Templates" hint={`A ready-made look: font, colours, outline, animation. Applies to ${SCOPE_WORD[scope]}.`}>
      <div className="grid grid-cols-2 gap-1.5">
        {[...BUILTIN_TEMPLATES, ...user].map((t) => (
          <div key={t.id} className="group relative">
            <button
              className={`${tile} w-full ${isActive(t) ? "border-accent bg-accent/15 ring-1 ring-accent" : ""}`}
              aria-pressed={isActive(t)}
              disabled={!!busy}
              onClick={() => apply(t)}
              title={t.description}
            >
              <span className="block truncate pr-3 text-[12px] font-medium text-gray-100">{busy === t.id ? "Applying…" : t.name}</span>
              <span className="block truncate text-[10px] text-gray-500">{t.builtIn ? t.description : "Your template"}</span>
            </button>
            {!t.builtIn && (
              <button
                aria-label={`Delete template ${t.name}`}
                title="Delete this template"
                className="absolute right-1 top-1 rounded px-1 text-[11px] text-gray-500 opacity-0 hover:text-red-400 focus:opacity-100 group-hover:opacity-100"
                onClick={() => void deleteUserTemplate(t.id)}
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>

      {naming ? (
        <div className="flex gap-1.5">
          <input
            autoFocus
            className="field"
            placeholder="Template name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
              if (e.key === "Escape") setNaming(false);
            }}
          />
          <button className="rounded-lg border border-edge px-3 text-[12px] text-gray-300 hover:bg-raised" onClick={() => void save()}>
            Save
          </button>
        </div>
      ) : (
        <button
          className="w-full rounded-lg border border-dashed border-edge px-3 py-1.5 text-left text-[12px] text-gray-400 hover:bg-raised hover:text-gray-100 disabled:opacity-40"
          disabled={!ids.length}
          title={ids.length ? "Save the selected line's look as a template" : "Select a line first"}
          onClick={() => setNaming(true)}
        >
          + Save selected line's look as a template
        </button>
      )}
      {msg && <p className={`text-[11px] ${msg.ok ? "text-green-400" : "text-red-400"}`}>{msg.text}</p>}
    </Card>
  );
}
