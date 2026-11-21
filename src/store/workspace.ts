import { create } from "zustand";
import { DEFAULT_PAGE, LAYOUT_PRESETS, compactLayouts, isPageId, layoutFor, layoutsFromJson, layoutsToJson, pageById, sanitizeLayout, type Layout, type PageId, type SavedLayouts, type SectionName } from "../lib/workspace/pages";

/**
 * Which page is open and how each page's panels are arranged (phase 27). This is interface state only: switching page
 * never touches the project, the playhead, the selection or the undo history, which live in their own stores.
 * Layouts and the last section per page are kept per user in localStorage.
 */

const KEY = "cutir:workspace";
const SECTIONS: SectionName[] = ["import", "media", "lyrics", "style", "motion", "effects", "titles", "audio", "captions"];
const isSection = (v: unknown): v is SectionName => SECTIONS.includes(v as SectionName);

type Saved = { page: PageId; layouts: SavedLayouts; sections: Partial<Record<PageId, SectionName>> };

function load(): Saved {
  const empty: Saved = { page: DEFAULT_PAGE, layouts: {}, sections: {} };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const j = JSON.parse(raw) as Partial<Saved>;
      const layouts: SavedLayouts = {};
      for (const [id, l] of Object.entries(j.layouts ?? {})) if (isPageId(id)) layouts[id] = sanitizeLayout(l, pageById(id).layout);
      const sections: Saved["sections"] = {};
      for (const [id, s] of Object.entries(j.sections ?? {})) if (isPageId(id) && isSection(s)) sections[id] = s;
      return { page: isPageId(j.page) ? j.page : DEFAULT_PAGE, layouts, sections };
    }
    // first run of this version: carry over the panel sizes and section from before pages existed
    const w = (k: string) => {
      const n = Number(localStorage.getItem(k));
      return n >= 150 ? n : undefined;
    };
    const old = { leftW: w("cutir:leftW"), chatW: w("cutir:chatW"), timelineH: w("cutir:tlH") };
    const sec = localStorage.getItem("cutir:section");
    const base = pageById(DEFAULT_PAGE).layout;
    if (old.leftW || old.chatW || old.timelineH) empty.layouts[DEFAULT_PAGE] = sanitizeLayout({ ...base, ...Object.fromEntries(Object.entries(old).filter(([, v]) => v)) }, base);
    if (isSection(sec)) empty.sections[DEFAULT_PAGE] = sec;
  } catch {
    /* storage unavailable or damaged: start from the defaults */
  }
  return empty;
}

type State = Saved & {
  setPage: (id: PageId) => void;
  setSection: (s: SectionName) => void;
  /** The layout of the open page. */
  layout: () => Layout;
  setLayout: (patch: Partial<Layout>) => void;
  applyPreset: (presetId: string) => void;
  resetPage: () => void;
  resetAll: () => void;
  importLayouts: (text: string) => boolean;
  exportLayouts: () => string;
};

export const useWorkspace = create<State>((set, get) => {
  const persist = () => {
    try {
      const { page, layouts, sections } = get();
      localStorage.setItem(KEY, JSON.stringify({ page, layouts: compactLayouts(layouts), sections }));
    } catch {
      /* storage unavailable */
    }
  };
  const commit = (p: Partial<Saved>) => {
    set(p);
    persist();
  };
  return {
    ...load(),
    setPage: (id) => {
      if (id !== get().page) commit({ page: id });
    },
    setSection: (s) => commit({ sections: { ...get().sections, [get().page]: s } }),
    layout: () => layoutFor(get().page, get().layouts),
    setLayout: (patch) => {
      const { page, layouts } = get();
      commit({ layouts: { ...layouts, [page]: sanitizeLayout({ ...layoutFor(page, layouts), ...patch }, pageById(page).layout) } });
    },
    applyPreset: (presetId) => {
      const p = LAYOUT_PRESETS.find((x) => x.id === presetId);
      if (!p) return;
      const { page, layouts } = get();
      commit({ layouts: { ...layouts, [page]: sanitizeLayout(p.apply(pageById(page).layout), pageById(page).layout) } });
    },
    resetPage: () => {
      const { page, layouts, sections } = get();
      const { [page]: _l, ...rest } = layouts;
      const { [page]: _s, ...restSec } = sections;
      void _l;
      void _s;
      commit({ layouts: rest, sections: restSec });
    },
    resetAll: () => commit({ layouts: {}, sections: {} }),
    importLayouts: (text) => {
      const l = layoutsFromJson(text);
      if (!l) return false;
      commit({ layouts: l });
      return true;
    },
    exportLayouts: () => layoutsToJson(get().layouts),
  };
});

/** The section shown on the open page: the one the user last chose there, else the page's own. */
export const sectionOf = (s: Pick<Saved, "page" | "sections">): SectionName => s.sections[s.page] ?? pageById(s.page).section;
