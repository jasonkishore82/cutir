import { Breadcrumb } from "./components/TimelinesCard";
import { useEffect, useMemo, useState } from "react";
import LeftPanel from "./components/LeftPanel";
import Preview from "./components/Preview";
import Timeline from "./components/Timeline";
import ChatPanel from "./components/ChatPanel";
import ExportDialog from "./components/ExportDialog";
import Home from "./components/Home";
import MenuBar from "./components/MenuBar";
import SettingsScreen from "./components/SettingsScreen";
import SectionTabs, { type SectionId } from "./components/SectionTabs";
import PageBar from "./components/PageBar";
import MacroPill from "./components/MacroPill";
import LibraryNotice from "./components/LibraryNotice";
import ColourDock from "./components/ColourDock";
import SystemNotice from "./components/SystemNotice";
import { installErrorCapture, useSystem } from "./store/system";
import { usePlugins } from "./store/plugins";
import { registerServiceWorker } from "./lib/system/pwa";
import QuickBar from "./components/QuickBar";
import DeliverPage from "./components/DeliverPage";
import CommandPalette from "./components/CommandPalette";
import CheatSheet from "./components/CheatSheet";
import { installKeymap } from "./lib/commands/dispatch";
import { applyPrefs } from "./store/prefs";
import { useWorkspace } from "./store/workspace";
import { layoutFor, pageById } from "./lib/workspace/pages";
import { Icon } from "./components/ui";
import { MediaLibrary } from "./components/MediaPool";
import { startAutosave, useProject } from "./store/project";
import { installUnloadSave, useLibrary } from "./store/library";
import { useMedia } from "./store/media";
import { startVersioning } from "./store/versions";
import { startStillsPersistence } from "./store/stillsSync";
import { startMcpBridge } from "./lib/mcpBridge";
import { ClaudeBadge } from "./components/ClaudeControlCard";

/** Drag handle on a panel divider. `dir` = +1 when dragging right grows the panel, -1 when it shrinks it. */
function ResizeHandle({ width, set, dir, min, max, reset }: {
  width: number; set: (w: number) => void; dir: 1 | -1; min: number; max: number; reset: number;
}) {
  const [active, setActive] = useState(false);
  const clampW = (w: number) => Math.min(max, Math.max(min, Math.round(w)));

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const w0 = width;
    setActive(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (ev: PointerEvent) => {
      set(clampW(w0 + dir * (ev.clientX - x0)));
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setActive(false);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  // the keyboard moves the divider too: arrows nudge it, Home resets it
  const onKey = (e: React.KeyboardEvent) => {
    const step = e.key === "ArrowLeft" ? -20 : e.key === "ArrowRight" ? 20 : 0;
    if (step) (e.preventDefault(), set(clampW(width + dir * step)));
    else if (e.key === "Home") (e.preventDefault(), set(reset));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title="Drag to resize, double-click to reset. With the keyboard: arrow keys, Home to reset"
      onPointerDown={onDown}
      onKeyDown={onKey}
      onDoubleClick={() => set(reset)}
      className="group relative w-2 shrink-0 cursor-col-resize touch-none"
    >
      {/* the gutter between floating panels; a small pill appears on hover */}
      <span className={`absolute inset-y-[38%] left-1/2 w-[3px] -translate-x-1/2 rounded-full transition-colors ${active ? "bg-accent" : "bg-transparent group-hover:bg-white/30"}`} />
    </div>
  );
}

/** Horizontal drag handle above the timeline: dragging up makes the timeline taller. */
function TimelineResizeHandle({ height, set, reset }: { height: number; set: (h: number) => void; reset: number }) {
  const [active, setActive] = useState(false);
  const min = 120;
  const max = Math.max(260, Math.round(window.innerHeight * 0.7));
  const clampH = (h: number) => Math.min(max, Math.max(min, Math.round(h)));

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const y0 = e.clientY;
    const h0 = height;
    setActive(true);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    const move = (ev: PointerEvent) => {
      set(clampH(h0 - (ev.clientY - y0)));
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setActive(false);
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
      onDoubleClick={() => set(reset)}
      onKeyDown={(e) => {
        const step = e.key === "ArrowUp" ? 20 : e.key === "ArrowDown" ? -20 : 0;
        if (step) (e.preventDefault(), set(clampH(height + step)));
        else if (e.key === "Home") (e.preventDefault(), set(reset));
      }}
      aria-valuenow={height}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
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
  const page = useWorkspace((s) => s.page);
  const layouts = useWorkspace((s) => s.layouts);
  const section = useWorkspace((s) => s.sections[s.page] ?? pageById(s.page).section) as SectionId;
  const layout = useMemo(() => layoutFor(page, layouts), [page, layouts]);
  const pageDef = pageById(page);
  const setLayout = useWorkspace.getState().setLayout;
  const setSection = useWorkspace.getState().setSection;

  useEffect(() => {
    applyPrefs();
    const off = installKeymap();
    const open = () => setExporting(true);
    window.addEventListener("cutir:open-export", open);
    return () => {
      off();
      window.removeEventListener("cutir:open-export", open);
    };
  }, []);

  useEffect(() => {
    useLibrary.getState().init(); // loads the project list (and migrates the old single autosave)
    startMcpBridge(); // connects to the Cutir MCP server only if the user switched Claude control on
    installUnloadSave();
    const stopSave = startAutosave((doc, view) => useLibrary.getState().saveContent(doc, view));
    const stopVersions = startVersioning();
    const stopStills = startStillsPersistence();
    const stopErrors = installErrorCapture();
    usePlugins.getState().start(); // effects, presets and script commands of installed plugins
    registerServiceWorker((update) => useSystem.setState({ update }));
    return () => (stopSave(), stopVersions(), stopErrors(), stopStills());
  }, []);

  // A song picked from the media library keeps its pool id when a project is saved, but its object URL only lives for a
  // session. Once the library has opened the file again, give the song its URL back (waveform, auto-sync, beats need it).
  useEffect(() => {
    const restore = () => {
      const a = useProject.getState().project.audio;
      const url = a?.mediaId ? useMedia.getState().urls[a.mediaId] : undefined;
      if (a && !a.url && url) useProject.setState((s) => ({ project: { ...s.project, audio: { ...a, url } } }));
    };
    restore();
    const u1 = useMedia.subscribe(restore);
    const u2 = useProject.subscribe(restore);
    return () => {
      u1();
      u2();
    };
  }, []);

  /* import from anywhere: paste files, or drop them on any part of the editor that does not take them itself */
  useEffect(() => {
    const inEditor = () => useLibrary.getState().screen === "editor";
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement;
      if (!inEditor() || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length) {
        e.preventDefault();
        void useMedia.getState().addFiles(files);
      }
    };
    const onDragOver = (e: DragEvent) => {
      if (inEditor() && e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      if (!inEditor() || e.defaultPrevented || !e.dataTransfer?.files.length) return;
      e.preventDefault();
      void useMedia.getState().addFiles(Array.from(e.dataTransfer.files));
    };
    window.addEventListener("paste", onPaste);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  const iconBtn = "grid h-8 w-8 place-items-center rounded-lg text-gray-400 hover:bg-white/[0.07] hover:text-white disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-400";
  const panel = "overflow-hidden rounded-2xl border border-white/[0.07] bg-panel/80 shadow-panel backdrop-blur-xl";

  if (screen === "home") return (
    <>
      <Home />
      <SettingsScreen />
      <CommandPalette />
      <CheatSheet />
    </>
  );

  return (
    <div className="flex h-full flex-col p-2">
      <a href="#main-content" className="skip-link">Skip to the viewer</a>
      <header className="mb-2 grid h-10 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 px-1">
        <div className="flex min-w-0 items-center gap-2">
          <button
            className="flex h-8 items-center gap-1 rounded-lg pl-1.5 pr-2.5 text-xs text-gray-300 hover:bg-white/[0.07] hover:text-white"
            onClick={() => useLibrary.getState().goHome()}
            title="Back to all projects"
          >
            <Icon name="back" className="h-4 w-4" /> <span className="hidden lg:inline">Projects</span>
          </button>
          <MenuBar onExport={() => setExporting(true)} onResetLayout={() => useWorkspace.getState().resetPage()} />
          <ProjectName />
          {saveFailed && <span className="shrink-0 text-[11px] text-red-400" title="Browser storage is full or blocked">Not saved</span>}
        </div>

        <SectionTabs value={section} onChange={setSection} />

        <div className="flex items-center justify-end gap-1">
          <ClaudeBadge />
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
        {layout.left && (
          <>
            <aside id="inspector" style={{ width: layout.leftW }} className={`${panel} shrink-0 overflow-y-auto`}>
              <LeftPanel tab={section} onGoto={setSection} />
            </aside>
            <ResizeHandle width={layout.leftW} set={(w) => setLayout({ leftW: w })} dir={1} min={240} max={480} reset={pageDef.layout.leftW} />
          </>
        )}
        <main id="main-content" tabIndex={-1} className={`${panel} min-w-0 flex-1 bg-bg outline-none`}>
          {pageDef.main === "deliver" ? <DeliverPage /> : pageDef.main === "library" || section === "import" ? <MediaLibrary /> : <Preview />}
        </main>
        {layout.dock && pageDef.main === "viewer" && (
          <>
            <ResizeHandle width={layout.dockW} set={(w) => setLayout({ dockW: w })} dir={-1} min={260} max={560} reset={pageDef.layout.dockW} />
            <aside style={{ width: layout.dockW }} className={`${panel} min-w-0 shrink-0`}>
              <ColourDock />
            </aside>
          </>
        )}
        {chatOpen && (
          <>
            <ResizeHandle width={layout.chatW} set={(w) => setLayout({ chatW: w })} dir={-1} min={280} max={720} reset={pageDef.layout.chatW} />
            <aside style={{ width: layout.chatW }} className={`${panel} min-w-0 shrink-0`}>
              <ChatPanel />
            </aside>
          </>
        )}
      </div>

      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
      <SettingsScreen />
      <CommandPalette />
      <CheatSheet />

      {layout.timeline && (
        <>
          <TimelineResizeHandle height={layout.timelineH} set={(h) => setLayout({ timelineH: h })} reset={pageDef.layout.timelineH} />
          {pageDef.quickBar && <QuickBar />}
          <footer style={{ height: layout.timelineH }} className={`${panel} shrink-0`}>
            <div className="flex h-full flex-col">
              <Breadcrumb />
              <div className="min-h-0 flex-1 [&>*]:h-full">
                <Timeline />
              </div>
            </div>
          </footer>
        </>
      )}
      <PageBar />
      <MacroPill />
      <LibraryNotice />
      <SystemNotice />
    </div>
  );
}
