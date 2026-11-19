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

function Tile({ item, onUse }: { item: MediaItem; onUse: (item: MediaItem) => void }) {
  const url = useMedia((s) => s.urls[item.id]);
  const thumb = useMedia((s) => s.thumbs[item.id]);
  const audioId = useProject((s) => s.project.audio?.mediaId);
  const bgId = useProject((s) => {
    const b = s.project.background;
    return b.type === "asset" ? b.asset?.mediaId : undefined;
  });
  const inUse = item.id === audioId || item.id === bgId;

  return (
    <div className={`overflow-hidden rounded-lg border ${inUse ? "border-accent/50 bg-accent/10" : "border-edge bg-black/20"}`}>
      <div className="relative aspect-video bg-black/40">
        {item.kind === "image" && url && <img src={url} alt="" className="h-full w-full object-cover" />}
        {item.kind === "video" && (thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" /> : <div className="h-full w-full bg-gradient-to-br from-white/5 to-transparent" />)}
        {item.kind === "audio" && (
          <div className="grid h-full w-full place-items-center bg-gradient-to-br from-accent/15 to-transparent text-accent">
            <Icon name="music" className="h-6 w-6" />
          </div>
        )}
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
        <button
          className="w-full truncate rounded-md border border-edge px-2 py-1 text-[11px] text-gray-300 hover:bg-raised hover:text-white"
          onClick={() => onUse(item)}
        >
          {item.kind === "audio" ? "Set song" : "Set background"}
        </button>
      </div>
    </div>
  );
}

/** Import any number of audio, video and image files; pick which one is the song or the background. */
export default function MediaPool({ onUse }: { onUse: (item: MediaItem) => void }) {
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
      {items.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {items.map((it) => (
            <Tile key={it.id} item={it} onUse={onUse} />
          ))}
        </div>
      )}
    </div>
  );
}
