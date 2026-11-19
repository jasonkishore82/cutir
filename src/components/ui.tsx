import type { ReactNode } from "react";

/** Small shared building blocks for the editor panels. */

export type IconName =
  | "media" | "lyrics" | "style" | "motion" | "undo" | "redo" | "ai" | "play" | "pause" | "skipBack"
  | "loop" | "back" | "export" | "plus" | "music" | "image" | "close" | "refresh" | "settings" | "dots" | "check" | "history" | "edit" | "archive" | "trash" | "sliders" | "storage" | "keyboard" | "import";

const PATHS: Record<IconName, ReactNode> = {
  media: <><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="9" cy="10" r="1.6" /><path d="M21 16l-5-5-8 9" /></>,
  lyrics: <path d="M4 7h16M4 12h10M4 17h13" />,
  style: <path d="M5 7V5h14v2M12 5v14M9 19h6" />,
  motion: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18" />,
  undo: <><path d="M9 14L4 9l5-5" /><path d="M4 9h10a6 6 0 010 12h-3" /></>,
  redo: <><path d="M15 14l5-5-5-5" /><path d="M20 9H10a6 6 0 000 12h3" /></>,
  ai: <><path d="M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9z" /><path d="M19 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" /></>,
  play: <path d="M8 5.5v13l11-6.5z" fill="currentColor" />,
  pause: <path d="M8 5v14M16 5v14" strokeWidth="3" />,
  skipBack: <><path d="M6 5v14" /><path d="M19 5.5v13L9 12z" fill="currentColor" /></>,
  loop: <><path d="M17 2l3 3-3 3" /><path d="M4 11V9a4 4 0 014-4h12" /><path d="M7 22l-3-3 3-3" /><path d="M20 13v2a4 4 0 01-4 4H4" /></>,
  back: <path d="M15 5l-7 7 7 7" />,
  export: <><path d="M12 15V4M7 9l5-5 5 5" /><path d="M5 13v6a2 2 0 002 2h10a2 2 0 002-2v-6" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  music: <><path d="M9 18V5l11-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" /></>,
  image: <><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="9" cy="10" r="1.6" /><path d="M21 16l-5-5-8 9" /></>,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  refresh: <><path d="M20 12a8 8 0 10-2.3 5.6" /><path d="M20 5v6h-6" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" /></>,
  dots: <><circle cx="5" cy="12" r="1.3" fill="currentColor" /><circle cx="12" cy="12" r="1.3" fill="currentColor" /><circle cx="19" cy="12" r="1.3" fill="currentColor" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  history: <><path d="M3 12a9 9 0 109-9 9 9 0 00-6.4 2.6L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" /></>,
  edit: <><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></>,
  archive: <><rect x="3" y="4" width="18" height="5" rx="1.5" /><path d="M5 9v9a2 2 0 002 2h10a2 2 0 002-2V9" /><path d="M10 13h4" /></>,
  sliders: <><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></>,
  storage: <><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></>,
  keyboard: <><rect x="2.5" y="6" width="19" height="12" rx="2.5" /><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M7 14h10" /></>,
  import: <><path d="M12 4v11M7 11l5 5 5-5" /><path d="M5 19h14" /></>,
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3" />,
};

export function Icon({ name, className = "h-4 w-4" }: { name: IconName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      {PATHS[name]}
    </svg>
  );
}

/** Rounded group inside the inspector. */
export function Card({ title, hint, children }: { title?: string; hint?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3.5">
      {title && (
        <div className="mb-3">
          <h3 className="text-[13px] font-semibold text-gray-100">{title}</h3>
          {hint && <p className="mt-0.5 text-[11px] leading-snug text-gray-500">{hint}</p>}
        </div>
      )}
      <div className="space-y-3">{children}</div>
    </section>
  );
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

/** Label on the left, value on the right, track below. */
export function Slider(props: { label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void }) {
  const shown = Number.isInteger(props.value) ? props.value : Number(props.value.toFixed(2));
  return (
    <label className="block">
      <span className="mb-2 flex items-baseline justify-between text-[12px]">
        <span className="text-gray-300">{props.label}</span>
        <span className="tabular-nums text-gray-500">{shown}{props.unit ?? ""}</span>
      </span>
      <input
        type="range"
        className="block w-full"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </label>
  );
}

/** iOS-style segmented control. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[] | readonly T[];
  onChange: (v: T) => void;
  label: string;
}) {
  const opts = (options as readonly (T | { value: T; label: string })[]).map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-0.5 rounded-lg bg-black/40 p-0.5">
      {opts.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={`flex-1 rounded-md px-2 py-1.5 text-xs capitalize ${on ? "bg-raised text-white shadow-sm shadow-black/40" : "text-gray-400 hover:text-gray-200"}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Full-width action row used for uploads and imports. */
export function ActionButton({ icon, children, onClick, active }: { icon?: IconName; children: ReactNode; onClick: () => void; active?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-[13px] ${
        active ? "border-accent/40 bg-accent/10 text-gray-100" : "border-edge bg-black/20 text-gray-300 hover:bg-raised hover:text-white"
      }`}
    >
      {icon && <Icon name={icon} className={`h-4 w-4 shrink-0 ${active ? "text-accent" : "text-gray-500"}`} />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}
