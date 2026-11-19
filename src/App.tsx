import { useEffect, useRef, useState } from "react";
import LeftPanel from "./components/LeftPanel";
import Preview from "./components/Preview";
import Timeline from "./components/Timeline";
import ChatPanel from "./components/ChatPanel";
import ExportDialog from "./components/ExportDialog";
import Home from "./components/Home";
import MenuBar from "./components/MenuBar";
import SettingsScreen from "./components/SettingsScreen";
import SectionTabs, { type SectionId } from "./components/SectionTabs";
import { Icon } from "./components/ui";
import { MediaLibrary } from "./components/MediaPool";
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
      className="group relative w-2 shrink-0 cursor-col-resize touch-none"
    >
      {/* the gutter between floating panels; a small pill appears on hover */}
      <span className={`absolute inset-y-[38%] left-1/2 w-[3px] -translate-x-1/2 rounded-full transition-colors ${active ? "bg-accent" : "bg-transparent group-hover:bg-white/30"}`} />
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
      className="group relative h-2 shrink-0 cursor-row-resize touch-none"
    >
      <span className={`absolute inset-x-[42%] top-1/2 h-[3px] -translate-y-1/2 rounded-full transition-colors ${active ? "bg-accent" : "bg-transparent group-hover:bg-white/30"}`} />
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
      className="w-44 min-w-0 truncate rounded-lg border border-transparent bg-transparent px-2 py-1 text-[13px] font-medium text-gray-100 hover:bg-white/5 focus:border-accent/70 focus:bg-bg"
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
  const [leftW, setLeftW] = useState(() => readW("cutir:leftW", 300));
  const [chatW, setChatW] = useState(() => readW("cutir:chatW", 360));
  const [tlH, setTlH] = useState(() => readW("cutir:tlH", 240));
  const [section, setSectionState] = useState<SectionId>(() => {
    try {
      const v = localStorage.getItem("cutir:section");
      return v === "media" || v === "lyrics" || v === "style" || v === "motion" ? v : "import";
    } catch {
      return "import";
    }
  });
  const setSection = (s: SectionId) => {
    setSectionState(s);
    try {
      localStorage.setItem("cutir:section", s);
    } catch {
      /* storage unavailable */
    }
  };

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

  const resetLayoutRef = useRef<() => void>(() => {});
  const iconBtn = "grid h-8 w-8 place-items-center rounded-lg text-gray-400 hover:bg-white/[0.07] hover:text-white disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-400";
  const panel = "overflow-hidden rounded-2xl border border-white/[0.07] bg-panel/80 shadow-panel backdrop-blur-xl";

  useEffect(() => {
    const on = () => resetLayoutRef.current();
    window.addEventListener("cutir:reset-layout", on);
    return () => window.removeEventListener("cutir:reset-layout", on);
  }, []);

  const resetLayout = () => {
    setLeftW(300);
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
  resetLayoutRef.current = resetLayout;

  if (screen === "home") return (
    <>
      <Home />
      <SettingsScreen />
    </>
  );

  return (
    <div className="flex h-full flex-col p-2">
      <header className="mb-2 grid h-10 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 px-1">
        <div className="flex min-w-0 items-center gap-2">
          <button
            className="flex h-8 items-center gap-1 rounded-lg pl-1.5 pr-2.5 text-xs text-gray-300 hover:bg-white/[0.07] hover:text-white"
            onClick={() => useLibrary.getState().goHome()}
            title="Back to all projects"
          >
            <Icon name="back" className="h-4 w-4" /> <span className="hidden lg:inline">Projects</span>
          </button>
          <MenuBar onExport={() => setExporting(true)} onResetLayout={resetLayout} />
          <ProjectName />
          {saveFailed && <span className="shrink-0 text-[11px] text-red-400" title="Browser storage is full or blocked">Not saved</span>}
        </div>

        <SectionTabs value={section} onChange={setSection} />

        <div className="flex items-center justify-end gap-1">
          <button className={iconBtn} onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo"><Icon name="undo" /></button>
          <button className={iconBtn} onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo"><Icon name="redo" /></button>
          <button
            className={`${iconBtn} ${chatOpen ? "bg-white/[0.07] !text-accent" : ""}`}
            onClick={toggleChat}
            title={chatOpen ? "Hide the AI assistant" : "Show the AI assistant"}
            aria-label="AI assistant"
            aria-pressed={chatOpen}
          >
            <Icon name="ai" />
          </button>
          <button
            className="btn-primary ml-1 flex h-8 items-center gap-1.5 rounded-lg px-3.5 text-xs"
            onClick={() => setExporting(true)}
          >
            <Icon name="export" className="h-3.5 w-3.5" /> Export
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside style={{ width: leftW }} className={`${panel} shrink-0 overflow-y-auto`}>
          <LeftPanel tab={section} onGoto={setSection} />
        </aside>
        <ResizeHandle width={leftW} set={setLeftW} dir={1} min={240} max={480} reset={300} storeKey="cutir:leftW" />
        <main className={`${panel} min-w-0 flex-1 bg-bg`}>
          {section === "import" ? <MediaLibrary /> : <Preview />}
        </main>
        {chatOpen && (
          <>
            <ResizeHandle width={chatW} set={setChatW} dir={-1} min={280} max={720} reset={360} storeKey="cutir:chatW" />
            <aside style={{ width: chatW }} className={`${panel} min-w-0 shrink-0`}>
              <ChatPanel />
            </aside>
          </>
        )}
      </div>

      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
      <SettingsScreen />

      <TimelineResizeHandle height={tlH} set={setTlH} />
      <footer style={{ height: tlH }} className={`${panel} shrink-0`}>
        <Timeline />
      </footer>
    </div>
  );
}
