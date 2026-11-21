import { PAGES, stepPage, type PageId } from "../lib/workspace/pages";
import { useWorkspace } from "../store/workspace";
import { usePrefs } from "../store/prefs";
import { formatCombo } from "../lib/commands/keymap";

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** The page bar under the timeline: Media, Cut, Edit, Motion, Color, Audio, Lyrics, Deliver. */
export default function PageBar() {
  const page = useWorkspace((s) => s.page);
  const setPage = useWorkspace((s) => s.setPage);
  const keymap = usePrefs((s) => s.keymap);
  const bindings = usePrefs.getState().bindings();
  void keymap;

  const onKey = (e: React.KeyboardEvent) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next: PageId = stepPage(page, step);
    setPage(next);
    requestAnimationFrame(() => document.getElementById(`page-${next}`)?.focus());
  };

  return (
    <nav aria-label="Pages" className="mt-2 flex shrink-0 justify-center">
      <div role="tablist" aria-label="Editor pages" onKeyDown={onKey} className="inline-flex gap-0.5 rounded-[10px] border border-white/[0.06] bg-white/[0.04] p-[3px]">
        {PAGES.map((p) => {
          const on = p.id === page;
          const key = bindings[`page.${p.id}`]?.[0];
          return (
            <button
              key={p.id}
              id={`page-${p.id}`}
              role="tab"
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              title={`${p.title}${key ? ` (${formatCombo(key, mac)})` : ""}`}
              onClick={() => setPage(p.id)}
              className={`rounded-lg px-4 py-1.5 text-xs font-medium ${on ? "bg-gradient-to-b from-white/[0.18] to-white/[0.05] text-white ring-1 ring-white/10" : "text-gray-400 hover:text-gray-100"}`}
            >
              {p.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
