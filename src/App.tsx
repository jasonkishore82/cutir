import { useEffect, useState } from "react";
import LeftPanel from "./components/LeftPanel";
import Preview from "./components/Preview";
import Timeline from "./components/Timeline";
import ChatPanel from "./components/ChatPanel";
import ExportDialog from "./components/ExportDialog";
import { downloadProject, loadAutosave, normalizeProject, startAutosave, useProject } from "./store/project";

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

export default function App() {
  const chatOpen = useProject((s) => s.chatOpen);
  const toggleChat = useProject((s) => s.toggleChat);
  const undo = useProject((s) => s.undo);
  const redo = useProject((s) => s.redo);
  const canUndo = useProject((s) => s.past.length > 0);
  const canRedo = useProject((s) => s.future.length > 0);
  const [exporting, setExporting] = useState(false);
  const [leftW, setLeftW] = useState(() => readW("cutir:leftW", 280));
  const [chatW, setChatW] = useState(() => readW("cutir:chatW", 360));

  useEffect(() => {
    const saved = loadAutosave();
    if (saved) useProject.getState().loadProject(saved);
    return startAutosave();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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

  const openProject = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        useProject.getState().loadProject(normalizeProject(JSON.parse(await f.text())));
      } catch {
        alert("Could not read that project file.");
      }
    };
    input.click();
  };

  const btn = "px-2 py-1 text-xs rounded border border-edge hover:bg-edge disabled:opacity-40 disabled:hover:bg-transparent";

  return (
    <div className="h-full flex flex-col">
      <header className="h-10 shrink-0 flex items-center gap-2 px-3 border-b border-edge bg-panel">
        <img src="/favicon.svg" alt="" className="h-6 w-6" />
        <span className="font-semibold tracking-wide text-accent">Cutir</span>
        <div className="ml-4 flex gap-1">
          <button className={btn} onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">Undo</button>
          <button className={btn} onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)">Redo</button>
        </div>
        <div className="ml-auto flex gap-1">
          <button className={btn} onClick={openProject}>Open</button>
          <button className={btn} onClick={() => downloadProject(useProject.getState().project)}>Save</button>
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

      <footer className="h-[200px] shrink-0 border-t border-edge bg-panel">
        <Timeline />
      </footer>
    </div>
  );
}
