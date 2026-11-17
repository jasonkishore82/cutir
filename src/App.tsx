import { useEffect } from "react";
import LeftPanel from "./components/LeftPanel";
import Preview from "./components/Preview";
import Timeline from "./components/Timeline";
import ChatPanel from "./components/ChatPanel";
import { downloadProject, loadAutosave, normalizeProject, startAutosave, useProject } from "./store/project";

export default function App() {
  const chatOpen = useProject((s) => s.chatOpen);
  const toggleChat = useProject((s) => s.toggleChat);
  const undo = useProject((s) => s.undo);
  const redo = useProject((s) => s.redo);
  const canUndo = useProject((s) => s.past.length > 0);
  const canRedo = useProject((s) => s.future.length > 0);

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
        <span className="font-semibold tracking-wide text-accent">Cutir</span>
        <div className="ml-4 flex gap-1">
          <button className={btn} onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">Undo</button>
          <button className={btn} onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)">Redo</button>
        </div>
        <div className="ml-auto flex gap-1">
          <button className={btn} onClick={openProject}>Open</button>
          <button className={btn} onClick={() => downloadProject(useProject.getState().project)}>Save</button>
          <button className={btn} onClick={toggleChat}>{chatOpen ? "Hide AI" : "Show AI"}</button>
        </div>
      </header>

      <div className="flex-1 min-h-0 flex">
        <aside className="w-[280px] shrink-0 border-r border-edge bg-panel overflow-y-auto">
          <LeftPanel />
        </aside>
        <main className="flex-1 min-w-0 bg-bg">
          <Preview />
        </main>
        {chatOpen && (
          <aside className="w-[360px] shrink-0 border-l border-edge bg-panel">
            <ChatPanel />
          </aside>
        )}
      </div>

      <footer className="h-[200px] shrink-0 border-t border-edge bg-panel">
        <Timeline />
      </footer>
    </div>
  );
}
