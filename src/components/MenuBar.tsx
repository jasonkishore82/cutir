import { useEffect, useRef, useState } from "react";
import { importMediaFiles, importProjectFile } from "../lib/fileActions";
import { Icon } from "./ui";
import { downloadProject, useProject } from "../store/project";
import { useLibrary } from "../store/library";
import { useChat } from "../store/chat";
import { useWorkspace } from "../store/workspace";
import { usePrefs } from "../store/prefs";
import { PAGES } from "../lib/workspace/pages";
import { formatCombo } from "../lib/commands/keymap";
import { runCommand } from "../lib/commands/registry";
import "../lib/commands/builtin";
import { useActiveConfig, useSettings } from "../store/settings";

type Item =
  | "sep"
  | { label: string; shortcut?: string; checked?: boolean; disabled?: boolean; info?: boolean; onSelect?: () => void };

type Menu = { id: string; label: string; items: Item[] };

/**
 * Menu bar for the editor: File, Edit, View, Settings.
 * Drawn as a small pill with a tight corner radius; menus open on click and switch on hover once one is open.
 */
export default function MenuBar({ onExport, onResetLayout }: { onExport: () => void; onResetLayout: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const focusFirst = useRef(false);

  const chatOpen = useProject((s) => s.chatOpen);
  const canUndo = useProject((s) => s.past.length > 0);
  const canRedo = useProject((s) => s.future.length > 0);
  const { provider, model } = useActiveConfig();
  const page = useWorkspace((s) => s.page);
  usePrefs((s) => s.keymap); // labels follow rebinding
  const keyOf = (id: string) => {
    const k = usePrefs.getState().bindings()[id]?.[0];
    return k ? formatCombo(k) : undefined;
  };

  const menus: Menu[] = [
    {
      id: "file",
      label: "File",
      items: [
        { label: "All projects", onSelect: () => useLibrary.getState().goHome() },
        { label: "Import media", onSelect: importMediaFiles },
        { label: "Import project", onSelect: importProjectFile },
        "sep",
        { label: "Save project file", onSelect: () => downloadProject(useProject.getState().project) },
        { label: "Export video", onSelect: onExport },
      ],
    },
    {
      id: "edit",
      label: "Edit",
      items: [
        { label: "Undo", shortcut: keyOf("edit.undo"), disabled: !canUndo, onSelect: () => useProject.getState().undo() },
        { label: "Redo", shortcut: keyOf("edit.redo"), disabled: !canRedo, onSelect: () => useProject.getState().redo() },
        "sep",
        { label: "New AI chat", onSelect: () => { useProject.setState({ chatOpen: true }); useChat.getState().newChat(); } },
      ],
    },
    {
      id: "view",
      label: "View",
      items: [
        { label: "Command palette", shortcut: keyOf("view.palette"), onSelect: () => void runCommand("view.palette") },
        { label: "Keyboard shortcuts", shortcut: keyOf("view.cheat"), onSelect: () => void runCommand("view.cheat") },
        "sep",
        ...PAGES.map((p) => ({ label: `${p.label} page`, shortcut: keyOf(`page.${p.id}`), checked: page === p.id, onSelect: () => useWorkspace.getState().setPage(p.id) })),
        "sep",
        { label: "AI panel", checked: chatOpen, onSelect: () => useProject.getState().toggleChat() },
        { label: "Show or hide the inspector", shortcut: keyOf("view.inspector"), onSelect: () => void runCommand("view.inspector") },
        { label: "Show or hide the timeline", shortcut: keyOf("view.timeline"), onSelect: () => void runCommand("view.timeline") },
        { label: "Reset this page's layout", onSelect: onResetLayout },
      ],
    },
    {
      id: "settings",
      label: "Settings",
      items: [
        { label: "AI models and API keys", onSelect: () => useSettings.getState().openDialog("ai") },
        { label: "Editor preferences", onSelect: () => useSettings.getState().openDialog("editor") },
        { label: "Storage", onSelect: () => useSettings.getState().openDialog("storage") },
        { label: "Keyboard shortcuts", onSelect: () => useSettings.getState().openDialog("shortcuts") },
        "sep",
        { label: provider.id === "none" ? "No AI provider selected" : `Using ${provider.name}${model ? `, ${model}` : ""}`, info: true, disabled: true },
      ],
    },
  ];

  const close = () => setOpen(null);

  // click outside closes
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  // keyboard-opened menus put focus on their first item
  useEffect(() => {
    if (open && focusFirst.current) {
      focusFirst.current = false;
      rootRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    }
  }, [open]);

  const move = (menuId: string, dir: 1 | -1) => {
    const i = menus.findIndex((m) => m.id === menuId);
    const next = menus[(i + dir + menus.length) % menus.length].id;
    focusFirst.current = true;
    setOpen(next);
  };

  const onKeyDown = (e: React.KeyboardEvent, menuId: string) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      rootRef.current?.querySelector<HTMLElement>(`[data-menu="${menuId}"]`)?.focus();
    } else if (e.key === "ArrowRight" && open) {
      e.preventDefault();
      move(menuId, 1);
    } else if (e.key === "ArrowLeft" && open) {
      e.preventDefault();
      move(menuId, -1);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const list = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
      if (!list.length) return;
      const i = list.indexOf(document.activeElement as HTMLElement);
      const step = e.key === "ArrowDown" ? 1 : -1;
      list[(i + step + list.length) % list.length].focus();
    }
  };

  return (
    <div
      ref={rootRef}
      role="menubar"
      aria-label="Main menu"
      className="inline-flex items-center gap-0.5 rounded-[5px] border border-white/[0.08] bg-white/[0.04] p-0.5"
    >
      {menus.map((m) => {
        const isOpen = open === m.id;
        return (
          <div key={m.id} className="relative" onKeyDown={(e) => onKeyDown(e, m.id)}>
            <button
              data-menu={m.id}
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : m.id)}
              onMouseEnter={() => open && setOpen(m.id)}
              onKeyDown={(e) => {
                if ((e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") && !isOpen) {
                  e.preventDefault();
                  e.stopPropagation();
                  focusFirst.current = true;
                  setOpen(m.id);
                }
              }}
              className={`rounded-[3px] px-2.5 py-1 text-xs leading-none transition-colors ${
                isOpen ? "bg-edge text-white" : "text-gray-300 hover:bg-edge hover:text-white"
              }`}
            >
              {m.label}
            </button>
            {isOpen && (
              <div
                role="menu"
                aria-label={m.label}
                className="absolute left-0 top-full z-50 mt-1.5 min-w-[240px] rounded-xl border border-white/10 bg-panel/95 p-1 text-xs shadow-2xl shadow-black/60 backdrop-blur-xl"
              >
                {m.items.map((it, i) =>
                  it === "sep" ? (
                    <div key={i} role="separator" className="my-1 h-px bg-edge" />
                  ) : (
                    <button
                      key={i}
                      role="menuitem"
                      disabled={it.disabled}
                      onClick={() => {
                        close();
                        it.onSelect?.();
                      }}
                      className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left focus:bg-accent/20 ${
                        it.info ? "text-gray-500" : "text-gray-200 hover:bg-accent/20 disabled:text-gray-600 disabled:hover:bg-transparent"
                      }`}
                    >
                      <span className="w-3 shrink-0 text-accent">{it.checked ? <Icon name="check" className="h-3 w-3" /> : null}</span>
                      <span className="flex-1 truncate">{it.label}</span>
                      {it.shortcut && <span className="text-[11px] text-gray-500">{it.shortcut}</span>}
                    </button>
                  )
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
