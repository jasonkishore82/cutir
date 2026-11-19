import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./ui";
import { useSettings } from "../store/settings";
import { useLibrary, type ProjectEntry } from "../store/library";
import type { Aspect } from "../store/project";

const SERIF = { letterSpacing: "-0.02em" }; // headings: tight, SF-style tracking (name kept for the call sites)

function ago(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  return new Date(t).toLocaleDateString();
}

/* ---------------- new project dialog ---------------- */

const ASPECTS: { id: Aspect; label: string; hint: string; w: number; h: number }[] = [
  { id: "16:9", label: "16:9", hint: "YouTube", w: 32, h: 18 },
  { id: "9:16", label: "9:16", hint: "Shorts / Reels", w: 18, h: 32 },
  { id: "1:1", label: "1:1", hint: "Square", w: 24, h: 24 },
];

function NewProjectDialog({ onClose, busy, onCreate }: { onClose: () => void; busy: boolean; onCreate: (o: { name: string; aspect: Aspect; fps: 30 | 60 }) => void }) {
  const [name, setName] = useState("");
  const [aspect, setAspect] = useState<Aspect>("16:9");
  const [fps, setFps] = useState<30 | 60>(30);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);

  const submit = () => !busy && onCreate({ name, aspect, fps });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-label="New project"
        className="w-[460px] max-w-[92vw] rounded-2xl border border-white/10 bg-panel p-5 space-y-5 shadow-2xl shadow-black/60"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter") submit();
        }}
      >
        <h2 className="text-lg font-semibold">New project</h2>

        <label className="block">
          <span className="label">Name</span>
          <input ref={ref} className="field" value={name} placeholder="Untitled project" onChange={(e) => setName(e.target.value)} />
        </label>

        <div>
          <span className="label">Aspect ratio</span>
          <div className="grid grid-cols-3 gap-2">
            {ASPECTS.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => setAspect(a.id)}
                className={`flex flex-col items-center gap-1.5 rounded border py-3 text-xs ${aspect === a.id ? "border-accent text-accent bg-accent/10" : "border-edge text-gray-400 hover:bg-edge"}`}
              >
                <span className="flex h-9 items-center">
                  <span className="rounded-[2px] border border-current" style={{ width: a.w, height: a.h }} />
                </span>
                <span className="font-medium">{a.label}</span>
                <span className="text-[10px] text-gray-500">{a.hint}</span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <span className="label">Frame rate</span>
          <div className="flex gap-2">
            {([30, 60] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFps(f)}
                className={`rounded border px-4 py-1.5 text-xs ${fps === f ? "border-accent text-accent bg-accent/10" : "border-edge text-gray-400 hover:bg-edge"}`}
              >
                {f} fps
              </button>
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button className="rounded border border-edge px-3 py-1.5 text-xs hover:bg-edge" onClick={onClose}>Cancel</button>
          <button className="btn-primary rounded-lg px-4 py-1.5 text-xs" onClick={submit} disabled={busy}>
            {busy ? "Creating" : "Create project"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- project card ---------------- */

function Card({ e, thumb, onOpen }: { e: ProjectEntry; thumb?: string; onOpen: () => void }) {
  const { renameProject, duplicateProject, deleteProject } = useLibrary.getState();
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [name, setName] = useState(e.name);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const off = (ev: MouseEvent) => !menuRef.current?.contains(ev.target as Node) && setMenu(false);
    window.addEventListener("mousedown", off);
    return () => window.removeEventListener("mousedown", off);
  }, [menu]);

  const commitRename = () => {
    setRenaming(false);
    if (name.trim() && name.trim() !== e.name) renameProject(e.id, name);
    else setName(e.name);
  };

  const item = "block w-full px-3 py-1.5 text-left text-xs hover:bg-edge";

  return (
    <div className="group relative rounded-2xl border border-white/[0.06] bg-white/[0.03] shadow-lg shadow-black/30 transition hover:-translate-y-0.5 hover:border-white/20" data-testid="project-card">
      <div
        role="button"
        tabIndex={0}
        aria-label={`Open ${e.name}`}
        onClick={() => !renaming && !confirmDelete && onOpen()}
        onKeyDown={(ev) => ev.key === "Enter" && !renaming && onOpen()}
        className="cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-2xl"
      >
        <div className="flex aspect-video items-center justify-center overflow-hidden rounded-t-2xl bg-black/40">
          {thumb ? (
            <img src={thumb} alt="" className="max-h-full max-w-full object-contain" />
          ) : (
            <div className="flex h-full w-full items-center justify-center" style={{ background: "linear-gradient(135deg,#1e2a6b,#5b3a8c,#d4687a,#f0a070)" }}>
              <img src="/favicon.svg" alt="" className="h-10 w-10 opacity-80" />
            </div>
          )}
        </div>
        <div className="space-y-0.5 p-3">
          {renaming ? (
            <input
              autoFocus
              className="field !py-0.5"
              value={name}
              onClick={(ev) => ev.stopPropagation()}
              onChange={(ev) => setName(ev.target.value)}
              onBlur={commitRename}
              onKeyDown={(ev) => {
                ev.stopPropagation();
                if (ev.key === "Enter") commitRename();
                if (ev.key === "Escape") (setName(e.name), setRenaming(false));
              }}
            />
          ) : (
            <p className="truncate text-sm font-medium text-gray-100" title={e.name}>{e.name}</p>
          )}
          <p className="truncate text-[11px] text-gray-500">
            {e.aspect}, {e.lineCount} line{e.lineCount === 1 ? "" : "s"}, edited {ago(e.updatedAt)}
          </p>
          {e.audioName && <p className="truncate text-[11px] text-gray-600">{e.audioName}</p>}
        </div>
      </div>

      {/* actions menu */}
      <div ref={menuRef} className="absolute right-2 top-2">
        <button
          aria-label="Project actions"
          onClick={() => setMenu((m) => !m)}
          className={`h-7 w-7 rounded bg-black/60 text-gray-200 hover:bg-black/80 ${menu ? "" : "opacity-0 group-hover:opacity-100 focus:opacity-100"}`}
        >
          <Icon name="dots" className="mx-auto h-4 w-4" />
        </button>
        {menu && (
          <div className="absolute right-0 z-10 mt-1 w-36 overflow-hidden rounded border border-edge bg-panel py-1 shadow-xl">
            <button className={item} onClick={() => (setMenu(false), setRenaming(true))}>Rename</button>
            <button className={item} onClick={() => (setMenu(false), duplicateProject(e.id))}>Duplicate</button>
            <button className={`${item} text-red-400`} onClick={() => (setMenu(false), setConfirmDelete(true))}>Delete</button>
          </div>
        )}
      </div>

      {confirmDelete && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 rounded-2xl bg-black/85 p-4 text-center">
          <p className="text-xs text-gray-200">
            Delete <b>{e.name}</b>? This removes its lyrics, settings and saved files. It can't be undone.
          </p>
          <div className="flex gap-2">
            <button className="rounded border border-edge px-3 py-1 text-xs hover:bg-edge" onClick={() => setConfirmDelete(false)}>Cancel</button>
            <button className="rounded bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-500" onClick={() => deleteProject(e.id)}>Delete</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- the screen ---------------- */

export default function Home() {
  const entries = useLibrary((s) => s.entries);
  const thumbs = useLibrary((s) => s.thumbs);
  const { createProject, openProject, importProject } = useLibrary.getState();

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"recent" | "name" | "created">("recent");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = entries.filter((e) => !q || e.name.toLowerCase().includes(q));
    return [...list].sort((a, b) =>
      sort === "name" ? a.name.localeCompare(b.name) : sort === "created" ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt
    );
  }, [entries, query, sort]);

  const open = async (id: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await openProject(id);
    } finally {
      setBusy(false);
    }
  };

  const create = async (o: { name: string; aspect: Aspect; fps: 30 | 60 }) => {
    setBusy(true);
    try {
      await createProject(o);
    } finally {
      setBusy(false);
    }
  };

  const importFile = () => {
    setError("");
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        await importProject(f.name.replace(/\.json$/i, ""), JSON.parse(await f.text()));
      } catch {
        setError("Could not read that project file.");
      }
    };
    input.click();
  };

  const side = "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm";

  return (
    <div className="flex h-full gap-2 p-2">
      {/* sidebar */}
      <aside className="flex w-[240px] shrink-0 flex-col rounded-2xl border border-white/[0.07] bg-panel/80 p-4 shadow-[inset_0_1px_0_rgb(255_255_255/0.07),0_8px_30px_rgb(0_0_0/0.4)] backdrop-blur-xl">
        <div className="mb-6 flex items-center gap-2.5">
          <img src="/favicon.svg" alt="" className="h-8 w-8" />
          <span className="text-gradient text-[24px] font-semibold leading-none" style={SERIF}>Cutir</span>
        </div>

        <button className="btn-primary mb-2 rounded-xl px-3 py-2.5 text-sm" onClick={() => setCreating(true)}>
          New project
        </button>
        <button className={`${side} border border-edge text-gray-300 hover:bg-edge`} onClick={importFile}>
          Open project file
        </button>

        <nav className="mt-6 space-y-1">
          <div className={`${side} bg-edge text-gray-100`}>
            <span>All projects</span> <span className="ml-auto text-xs text-gray-500">{entries.length}</span>
          </div>
        </nav>

        <button className={`${side} mt-2 text-gray-400 hover:bg-white/[0.06] hover:text-gray-100`} onClick={() => useSettings.getState().openDialog()}>
          <span>Settings</span>
        </button>

        <p className="mt-auto text-[11px] leading-relaxed text-gray-600">
          Projects are saved in this browser.
        </p>
      </aside>

      {/* main */}
      <main className="min-w-0 flex-1 overflow-y-auto rounded-2xl border border-white/[0.07] bg-panel/60 backdrop-blur-xl">
        <div className="mx-auto max-w-[1100px] px-8 py-8">
          <div className="mb-6 flex flex-wrap items-center gap-3">
            <h1 className="text-gradient mr-auto text-[28px] font-semibold" style={SERIF}>Projects</h1>
            <input
              className="field !w-60"
              placeholder="Search projects"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search projects"
            />
            <select className="field !w-40" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort projects">
              <option value="recent">Last edited</option>
              <option value="created">Date created</option>
              <option value="name">Name</option>
            </select>
          </div>

          {error && <p className="mb-4 text-sm text-red-400">{error}</p>}

          {entries.length === 0 ? (
            <div className="mt-24 flex flex-col items-center gap-4 text-center">
              <img src="/favicon.svg" alt="" className="h-16 w-16" />
              <h2 className="text-gradient text-3xl font-semibold" style={SERIF}>No projects yet</h2>
              <p className="max-w-sm text-sm text-gray-500">Create a project to start.</p>
              <button className="btn-primary mt-2 rounded-xl px-5 py-2.5 text-sm" onClick={() => setCreating(true)}>
                New project
              </button>
            </div>
          ) : shown.length === 0 ? (
            <p className="mt-16 text-center text-sm text-gray-500">No projects match "{query}".</p>
          ) : (
            <div className="grid gap-5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))" }}>
              {shown.map((e) => (
                <Card key={e.id} e={e} thumb={thumbs[e.id]} onOpen={() => open(e.id)} />
              ))}
            </div>
          )}
        </div>
      </main>

      {creating && <NewProjectDialog busy={busy} onClose={() => !busy && setCreating(false)} onCreate={create} />}
    </div>
  );
}
