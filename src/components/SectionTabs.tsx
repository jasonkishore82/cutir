import { Icon, type IconName } from "./ui";

export type SectionId = "import" | "media" | "lyrics" | "style" | "motion" | "effects" | "titles" | "audio";

export const SECTIONS: { id: SectionId; label: string; icon: IconName; title: string }[] = [
  { id: "import", label: "Import", icon: "import", title: "Import" },
  { id: "media", label: "Media", icon: "media", title: "Media" },
  { id: "lyrics", label: "Lyrics", icon: "lyrics", title: "Lyrics" },
  { id: "style", label: "Style", icon: "style", title: "Text style" },
  { id: "motion", label: "Motion", icon: "motion", title: "Motion" },
  { id: "titles", label: "Titles", icon: "style", title: "Titles, shapes and generators" },
  { id: "audio", label: "Audio", icon: "music", title: "Audio mixer, loudness and voice-over" },
  { id: "effects", label: "Effects", icon: "effects", title: "Effects and transitions" },
];

/** Top-bar section switcher: decides what the inspector on the left shows. */
export default function SectionTabs({ value, onChange }: { value: SectionId; onChange: (s: SectionId) => void }) {
  const onKey = (e: React.KeyboardEvent) => {
    const i = SECTIONS.findIndex((s) => s.id === value);
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = SECTIONS[(i + step + SECTIONS.length) % SECTIONS.length];
    onChange(next.id);
    requestAnimationFrame(() => document.getElementById(`tab-${next.id}`)?.focus());
  };
  return (
    <div role="tablist" aria-label="Editor sections" onKeyDown={onKey} className="inline-flex gap-0.5 rounded-[10px] border border-white/[0.06] bg-white/[0.04] p-[3px]">
      {SECTIONS.map((s) => {
        const on = s.id === value;
        return (
          <button
            key={s.id}
            id={`tab-${s.id}`}
            role="tab"
            aria-selected={on}
            aria-controls="inspector"
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(s.id)}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium ${
              on ? "bg-gradient-to-b from-white/[0.18] to-white/[0.05] text-white shadow-[0_0_18px_rgb(91_157_255/0.28)] ring-1 ring-white/10" : "text-gray-400 hover:text-gray-100"
            }`}
          >
            <Icon name={s.icon} className={`h-3.5 w-3.5 ${on ? "text-accent" : ""}`} />
            <span className="hidden md:inline">{s.label}</span>
          </button>
        );
      })}
    </div>
  );
}
