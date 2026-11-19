import { useEffect, useState } from "react";
import LeftPanel from "./components/LeftPanel";
import Preview from "./components/Preview";
import Timeline from "./components/Timeline";
import ChatPanel from "./components/ChatPanel";
import ExportDialog from "./components/ExportDialog";
import Home from "./components/Home";
import MenuBar from "./components/MenuBar";
import SettingsDialog from "./components/SettingsDialog";
import { startAutosave, useProject } from "./store/project";
import { installUnloadSave, useLibrary } from "./store/library";

const readW = (k: string, d: number) => {
  try {
    const n = Number(localStorage.getItem(k));
    return n >= 150 ? n : d;
  } catch {
    return d;
  }
};

/** Drag handle on a panel divider. `dir` = +1 when dragging right grows the panel, -1 when it shrinks it. */
function ResizeHandle({ width, set, dir, min, max, reset, storeKey }: {
  width: number; set: (w: number) => void; dir: 1 | -1; min: number; max: number; reset: number; storeKey: string;
}) {
  const [active, setActive] = useState(false);
  const clampW = (w: number) => Math.min(max, Math.max(min, Math.round(w)));
  const save = (w: number) => {
    try {
      localStorage.setItem(storeKey, String(w));
    } catch {
      /* storage unavailable */
    }
  };

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const w0 = width;
    let last = w0;
    setActive(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (ev: PointerEvent) => {
      last = clampW(w0 + dir * (ev.clientX - x0));
      set(last);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setActive(false);
      save(last);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize, double-click to reset"
      onPointerDown={onDown}
      onDoubleClick={() => {
        set(reset);
        save(reset);
      }}
      className="group relative w-1 shrink-0 cursor-col-resize touch-none"
    >
      {/* wider invisible hit area, thin visible line */}
      <span className="absolute inset-y-0 -left-1.5 -right-1.5" />
      <span className={`absolute inset-y-0 left-0 w-px transition-colors ${active ? "bg-sky-500 w-[3px]" : "bg-edge group-hover:bg-sky-500"}`} />
    </div>
  );
}

/** Horizontal drag handle above the timeline: dragging up makes the timeline taller. */
function TimelineResizeHandle({ height, set }: { height: number; set: (h: number) => void }) {
  const [active, setActive] = useState(false);
  const min = 170;
  const max = Math.max(260, Math.round(window.innerHeight * 0.7));
  const clampH = (h: number) => Math.min(max, Math.max(min, Math.round(h)));

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const y0 = e.clientY;
    const h0 = height;
    let last = h0;
    setActive(true);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    const move = (ev: PointerEvent) => {
      last = clampH(h0 - (ev.clientY - y0));
      set(last);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setActive(false);
      try {
        localStorage.setItem("cutir:tlH", String(last));
      } catch {
        /* storage unavailable */
      }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      title="Drag to resize the timeline, double-click to reset"
      onPointerDown={onDown}
      onDoubleClick={() => {
        set(240);
        try {
          localStorage.setItem("cutir:tlH", "240");
        } catch {
          /* ignore */
        }
      }}
      className="group relative h-1 shrink-0 cursor-row-resize touch-none"
    >
      <span className="absolute inset-x-0 -top-1.5 -bottom-1.5" />
      <span className={`absolute inset-x-0 top-0 transition-colors ${active ? "h-[3px] bg-sky-500" : "h-px bg-edge group-hover:bg-sky-500"}`} />
    </div>
  );
}

/** Editable project name in the editor header. */
function ProjectName() {
  const id = useLibrary((s) => s.currentId);
  const name = useLibrary((s) => s.entries.find((e) => e.id === s.currentId)?.name ?? "");
  const [draft, setDraft] = useState<string | null>(null);
  if (!id) return null;
  const commit = () => {
    if (draft !== null && draft.trim() && draft.trim() !== name) useLibrary.getState().renameProject(id, draft);
    setDraft(null);
  };
  return (
    <input
      aria-label="Project name"
      className="w-48 truncate rounded border border-transparent bg-transparent px-2 py-0.5 text-sm text-gray-200 hover:border-edge focus:border-accent focus:bg-bg"
      value={draft ?? name}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") (setDraft(null), e.currentTarget.blur());
      }}
    />
  );
}

export default function App() {
  const screen = useLibrary((s) => s.screen);
  const saveFailed = useLibrary((s) => s.saveFailed);
  const chatOpen = useProject((s) => s.chatOpen);
  const toggleChat = useProject((s) => s.toggleChat);
  const undo = useProject((s) => s.undo);
  const redo = useProject((s) => s.redo);
  const canUndo = useProject((s) => s.past.length > 0);
  const canRedo = useProject((s) => s.future.length > 0);
  const [exporting, setExporting] = useState(false);
  const [leftW, setLeftW] = useState(() => readW("cutir:leftW", 280));
  const [chatW, setChatW] = useState(() => readW("cutir:chatW", 360));
  const [tlH, setTlH] = useState(() => readW("cutir:tlH", 240));

  useEffect(() => {
    useLibrary.getState().init(); // loads the project list (and migrates the old single autosave)
    installUnloadSave();
    return startAutosave((p) => useLibrary.getState().saveContent(p));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (useLibrary.getState().screen !== "editor") return;
      const t = e.target as HTMLElement;
      const typing = t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        if (typing) return; // let text fields use native undo
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        if (typing) return;
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const btn = "px-2 py-1 text-xs rounded border border-edge hover:bg-edge disabled:opacity-40 disabled:hover:bg-transparent";

  const resetLayout = () => {
    setLeftW(280);
    setChatW(360);
    setTlH(240);
    for (const k of ["cutir:leftW", "cutir:chatW", "cutir:tlH"]) {
      try {
        localStorage.removeItem(k);
      } catch {
        /* storage unavailable */
      }
    }
  };

  if (screen === "home") return <Home />;

  return (
    <div className="h-full flex flex-col">
      <header className="h-10 shrink-0 flex items-center gap-2 px-3 border-b border-edge bg-panel">
        <button className={`${btn} flex items-center gap-1.5`} onClick={() => useLibrary.getState().goHome()} title="Back to all projects">
          <span aria-hidden>‹</span> Projects
        </button>
        <img src="/favicon.svg" alt="" className="ml-1 h-6 w-6" />
        <MenuBar onExport={() => setExporting(true)} onResetLayout={resetLayout} />
        <ProjectName />
        {saveFailed && <span className="text-[11px] text-red-400" title="Browser storage is full or blocked">⚠ not saved</span>}
        <div className="ml-auto flex gap-1">
          <button className={btn} onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">Undo</button>
          <button className={btn} onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)">Redo</button>
        </div>
        <div className="flex gap-1">
          <button className={`${btn} border-accent text-accent`} onClick={() => setExporting(true)}>Export</button>
          <button className={btn} onClick={toggleChat}>{chatOpen ? "Hide AI" : "Show AI"}</button>
        </div>
      </header>

      <div className="flex-1 min-h-0 flex">
        <aside style={{ width: leftW }} className="shrink-0 bg-panel overflow-y-auto">
          <LeftPanel />
        </aside>
        <ResizeHandle width={leftW} set={setLeftW} dir={1} min={220} max={480} reset={280} storeKey="cutir:leftW" />
        <main className="flex-1 min-w-0 bg-bg">
          <Preview />
        </main>
        {chatOpen && (
          <>
            <ResizeHandle width={chatW} set={setChatW} dir={-1} min={280} max={720} reset={360} storeKey="cutir:chatW" />
            <aside style={{ width: chatW }} className="shrink-0 bg-panel min-w-0">
              <ChatPanel />
            </aside>
          </>
        )}
      </div>

      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
      <SettingsDialog />

      <TimelineResizeHandle height={tlH} set={setTlH} />
      <footer style={{ height: tlH }} className="shrink-0 bg-panel">
        <Timeline />
      </footer>
    </div>
  );
}
