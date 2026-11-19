import { useRef, useState } from "react";
import { useMedia, type MediaItem } from "../store/media";
import { useProject } from "../store/project";
import { Icon } from "./ui";

const ACCEPT = "audio/*,video/*,image/*,.mp3,.wav,.m4a,.aac,.ogg,.flac,.opus,.mp4,.mov,.webm,.mkv";

const mmss = (s?: number) => {
  if (s === undefined) return "";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};
const size = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Picture for a pool item: the image itself, a video frame, or a music icon. */
export function PoolThumb({ item }: { item: MediaItem }) {
  const url = useMedia((s) => s.urls[item.id]);
  const thumb = useMedia((s) => s.thumbs[item.id]);
  if (item.kind === "image" && url) return <img src={url} alt="" className="h-full w-full object-cover" />;
  if (item.kind === "video") return thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" /> : <div className="h-full w-full bg-gradient-to-br from-white/5 to-transparent" />;
  if (item.kind === "audio")
    return (
      <div className="grid h-full w-full place-items-center bg-gradient-to-br from-accent/15 to-transparent text-accent">
        <Icon name="music" className="h-6 w-6" />
      </div>
    );
  return <div className="h-full w-full" />;
}

function Tile({ item, onUse }: { item: MediaItem; onUse?: (item: MediaItem) => void }) {
  const audioId = useProject((s) => s.project.audio?.mediaId);
  const bgId = useProject((s) => {
    const b = s.project.background;
    return b.type === "asset" ? b.asset?.mediaId : undefined;
  });
  const inUse = item.id === audioId || item.id === bgId;

  return (
    <div className={`overflow-hidden rounded-lg border ${inUse ? "border-accent/50 bg-accent/10" : "border-edge bg-black/20"}`}>
      <div className="relative aspect-video bg-black/40">
        <PoolThumb item={item} />
        <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] capitalize text-gray-200">
          {item.kind}
          {item.duration !== undefined ? `, ${mmss(item.duration)}` : ""}
        </span>
        <button
          className="absolute left-1 top-1 grid h-6 w-6 place-items-center rounded-md bg-black/60 text-gray-300 hover:bg-black/80 hover:text-red-300"
          onClick={() => useMedia.getState().remove(item.id)}
          title="Remove from the media pool"
          aria-label={`Remove ${item.name}`}
        >
          <Icon name="trash" className="h-3.5 w-3.5" />
        </button>
        {inUse && <span className="absolute right-1 top-1 rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium text-black">In use</span>}
      </div>
      <div className="space-y-1.5 p-2">
        <p className="truncate text-[12px] text-gray-200" title={item.name}>{item.name}</p>
        <p className="text-[10px] text-gray-500">{size(item.size)}</p>
        {onUse && (
          <button
            className="w-full whitespace-nowrap rounded-md border border-edge px-1 py-1 text-[11px] text-gray-300 hover:bg-raised hover:text-white"
            onClick={() => onUse(item)}
          >
            {item.kind === "audio" ? "Set song" : "Set background"}
          </button>
        )}
      </div>
    </div>
  );
}

/** Import any number of audio, video and image files and manage them. They are used from the Media tab. */
export default function MediaPool({ onUse, compact }: { onUse?: (item: MediaItem) => void; compact?: boolean }) {
  const items = useMedia((s) => s.items);
  const notice = useMedia((s) => s.notice);
  const fileRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);

  const add = async (files: FileList | File[] | null) => {
    if (!files || !files.length) return;
    setBusy(true);
    try {
      await useMedia.getState().addFiles(Array.from(files));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void add(e.dataTransfer.files);
      }}
      className={`space-y-3 rounded-lg ${over ? "outline outline-2 outline-dashed outline-accent/60 outline-offset-4" : ""}`}
    >
      <input ref={fileRef} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => void add(e.target.files)} />
      <button
        onClick={() => fileRef.current?.click()}
        disabled={busy}
        className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-white/20 bg-black/20 px-3 py-3 text-[13px] text-gray-300 hover:border-accent/50 hover:bg-raised hover:text-white disabled:opacity-60"
      >
        <Icon name="plus" className="h-4 w-4" />
        {busy ? "Importing" : "Import audio, video and images"}
      </button>
      <p className="text-[11px] text-gray-500">Select several files at once, or drop them here.</p>
      {notice && (
        <p className="flex items-start justify-between gap-2 text-[11px] text-yellow-400" role="status">
          <span>{notice}</span>
          <button className="shrink-0 text-gray-500 hover:text-gray-200" onClick={() => useMedia.getState().dismissNotice()} aria-label="Dismiss">
            <Icon name="close" className="h-3 w-3" />
          </button>
        </p>
      )}
      {compact && <p className="text-[11px] text-gray-500">{items.length} file{items.length === 1 ? "" : "s"} in the library.</p>}
      {!compact && items.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {items.map((it) => (
            <Tile key={it.id} item={it} onUse={onUse} />
          ))}
        </div>
      )}
    </div>
  );
}

type Filter = "all" | "audio" | "video" | "image";

/** The Import screen: every imported file in a large grid, in place of the preview. Files are used from the Media tab. */
export function MediaLibrary() {
  const items = useMedia((s) => s.items);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const add = async (files: FileList | File[] | null) => {
    if (!files || !files.length) return;
    setBusy(true);
    try {
      await useMedia.getState().addFiles(Array.from(files));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const q = query.trim().toLowerCase();
  const shown = items.filter((i) => (filter === "all" || i.kind === filter) && (!q || i.name.toLowerCase().includes(q)));
  const counts = { all: items.length, audio: items.filter((i) => i.kind === "audio").length, video: items.filter((i) => i.kind === "video").length, image: items.filter((i) => i.kind === "image").length };
  const tabs: { id: Filter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "audio", label: "Audio" },
    { id: "video", label: "Video" },
    { id: "image", label: "Images" },
  ];

  return (
    <div
      className={`flex h-full flex-col ${over ? "outline outline-2 outline-dashed outline-accent/60 -outline-offset-8" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void add(e.dataTransfer.files);
      }}
    >
      <input ref={fileRef} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => void add(e.target.files)} />
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-edge px-5 py-3">
        <h2 className="text-gradient mr-auto text-[19px] font-semibold tracking-tight">Library</h2>
        <div role="tablist" aria-label="Filter media" className="flex gap-0.5 rounded-lg bg-black/40 p-0.5">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={filter === t.id}
              onClick={() => setFilter(t.id)}
              className={`rounded-md px-2.5 py-1 text-xs ${filter === t.id ? "bg-raised text-white" : "text-gray-400 hover:text-gray-200"}`}
            >
              {t.label} <span className="text-gray-500">{counts[t.id]}</span>
            </button>
          ))}
        </div>
        <input className="field !w-48 !py-1" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search media" />
        <button className="btn-primary flex h-8 items-center gap-1.5 rounded-lg px-3.5 text-xs" onClick={() => fileRef.current?.click()} disabled={busy}>
          <Icon name="plus" className="h-3.5 w-3.5" />
          {busy ? "Importing" : "Import files"}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {items.length === 0 ? (
          <button
            onClick={() => fileRef.current?.click()}
            className="grid h-full min-h-[240px] w-full place-items-center rounded-2xl border border-dashed border-white/20 text-center text-gray-400 hover:border-accent/50 hover:text-gray-200"
          >
            <span className="space-y-2">
              <Icon name="import" className="mx-auto h-8 w-8" />
              <span className="block text-sm">Drop audio, video and images here, or click to choose files</span>
            </span>
          </button>
        ) : shown.length === 0 ? (
          <p className="py-16 text-center text-sm text-gray-500">No files match.</p>
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))" }}>
            {shown.map((it) => (
              <Tile key={it.id} item={it} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
