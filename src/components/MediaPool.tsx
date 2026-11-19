import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ACCEPT, binTree, useMedia, type MediaItem, type SmartBin } from "../store/media";
import { canLink } from "../lib/filestore";
import { useProject } from "../store/project";
import { activeTimeline } from "../model/convert";
import { seek } from "../lib/transport";
import { poolMediaId, timecode, useTimelineUi } from "../timeline/ui";
import { POOL_MIME } from "./TrackLanes";
import { Icon } from "./ui";

const mmss = (s?: number) => {
  if (s === undefined) return "";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};
const size = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Ids of pool items used anywhere in the project: on a timeline, as the song or as the lyric background. */
export function useUsedIds(): Set<string> {
  const doc = useProject((s) => s.doc);
  const view = useProject((s) => s.project);
  return useMemo(() => {
    const used = new Set<string>();
    const byMedia = new Map(doc.media.map((m) => [m.id, m.poolId]));
    for (const tl of doc.timelines) for (const c of tl.clips) if (c.mediaId && byMedia.get(c.mediaId)) used.add(byMedia.get(c.mediaId)!);
    if (view.audio?.mediaId) used.add(view.audio.mediaId);
    if (view.background.type === "asset" && view.background.asset?.mediaId) used.add(view.background.asset.mediaId);
    return used;
  }, [doc, view]);
}

/** Picture for a pool item: the image itself, a video frame, or an icon. */
export function PoolThumb({ item }: { item: MediaItem }) {
  const url = useMedia((s) => s.urls[item.id]);
  const thumb = useMedia((s) => s.thumbs[item.id]);
  if (item.kind === "image" && url) return <img src={url} alt="" className="h-full w-full object-cover" draggable={false} />;
  if (item.kind === "video") return thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" draggable={false} /> : <div className="h-full w-full bg-gradient-to-br from-white/5 to-transparent" />;
  const glyph = item.kind === "audio" ? <Icon name="music" className="h-6 w-6" /> : <span className="text-[13px] font-semibold">{item.kind === "font" ? "Aa" : "CC"}</span>;
  return <div className="grid h-full w-full place-items-center bg-gradient-to-br from-accent/15 to-transparent text-accent">{glyph}</div>;
}

/** Import progress and messages, shown wherever files can be imported. */
function ImportStatus() {
  const progress = useMedia((s) => s.progress);
  const notice = useMedia((s) => s.notice);
  return (
    <>
      {progress && (
        <div className="space-y-1" role="status" aria-live="polite">
          <div className="flex justify-between text-[11px] text-gray-400">
            <span className="truncate">Importing {progress.current}</span>
            <span className="tabular-nums">{progress.done + 1} / {progress.total}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-black/30">
            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${((progress.done + 0.5) / progress.total) * 100}%` }} />
          </div>
        </div>
      )}
      {notice && (
        <p className="flex items-start justify-between gap-2 text-[11px] text-yellow-400" role="status">
          <span>{notice}</span>
          <button className="shrink-0 text-gray-500 hover:text-gray-200" onClick={() => useMedia.getState().dismissNotice()} aria-label="Dismiss">
            <Icon name="close" className="h-3 w-3" />
          </button>
        </p>
      )}
    </>
  );
}

/** Compact importer for the side panel. The full browser is the Import screen (MediaLibrary). */
export default function MediaPool({ compact }: { compact?: boolean }) {
  const items = useMedia((s) => s.items);
  const busy = useMedia((s) => !!s.progress);
  const fileRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const add = (files: FileList | null) => files?.length && void useMedia.getState().addFiles(Array.from(files)).finally(() => fileRef.current && (fileRef.current.value = ""));
  return (
    <div
      onDragOver={(e) => (e.preventDefault(), setOver(true))}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => (e.preventDefault(), setOver(false), add(e.dataTransfer.files))}
      className={`space-y-3 rounded-lg ${over ? "outline outline-2 outline-dashed outline-accent/60 outline-offset-4" : ""}`}
    >
      <input ref={fileRef} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => add(e.target.files)} />
      <button
        onClick={() => fileRef.current?.click()}
        disabled={busy}
        className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-white/20 bg-black/20 px-3 py-3 text-[13px] text-gray-300 hover:border-accent/50 hover:bg-raised hover:text-white disabled:opacity-60"
      >
        <Icon name="plus" className="h-4 w-4" />
        {busy ? "Importing" : "Import media"}
      </button>
      {canLink() && (
        <button className="w-full rounded-lg border border-edge px-3 py-1.5 text-[12px] text-gray-400 hover:bg-raised hover:text-gray-100" onClick={() => void useMedia.getState().linkFiles()} title="Large files stay where they are; the project keeps a link instead of a copy">
          Link files without copying
        </button>
      )}
      <p className="text-[11px] text-gray-500">Video, audio, images, subtitles (.srt .vtt .lrc .ass) and fonts. Drop files anywhere, or paste them.</p>
      <ImportStatus />
      {compact && <p className="text-[11px] text-gray-500">{items.length} file{items.length === 1 ? "" : "s"} in the library.</p>}
    </div>
  );
}

type KindFilter = "all" | "video" | "audio" | "image" | "subtitle" | "font";
type UseFilter = "all" | "used" | "unused";
type Where = { smart: SmartBin } | { bin: string };

/** The Import screen: the whole media pool with bins, search, filters, grid and list views. */
export function MediaLibrary() {
  const items = useMedia((s) => s.items);
  const bins = useMedia((s) => s.bins);
  const status = useMedia((s) => s.status);
  const used = useUsedIds();
  const sourceId = useTimelineUi((s) => s.sourceId);
  const [where, setWhere] = useState<Where>({ smart: "all" });
  const [kind, setKind] = useState<KindFilter>("all");
  const [usage, setUsage] = useState<UseFilter>("all");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"grid" | "list">(() => {
    try {
      return localStorage.getItem("cutir:poolView") === "list" ? "list" : "grid";
    } catch {
      return "grid";
    }
  });
  const [over, setOver] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const relinkRef = useRef<HTMLInputElement>(null);
  const relinkId = useRef<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem("cutir:poolView", view);
    } catch {
      /* ignore */
    }
  }, [view]);

  const inBin = "bin" in where ? binTree(bins, where.bin) : null;
  const q = query.trim().toLowerCase();
  const shown = items.filter(
    (i) =>
      (kind === "all" || i.kind === kind) &&
      (usage === "all" || (usage === "used") === used.has(i.id)) &&
      (!q || i.name.toLowerCase().includes(q)) &&
      ("bin" in where ? !!i.binId && inBin!.has(i.binId) : where.smart === "all" || (where.smart === "unused" ? !used.has(i.id) : i.kind === where.smart))
  );
  const binId = "bin" in where ? where.bin : undefined;
  const add = (files: FileList | File[] | null) => files && files.length && void useMedia.getState().addFiles(Array.from(files), binId).finally(() => fileRef.current && (fileRef.current.value = ""));
  const select = (id: string) => useTimelineUi.setState({ sourceId: id === sourceId ? null : id });
  const selected = items.find((i) => i.id === sourceId);

  const reveal = (id: string) => {
    const tl = activeTimeline(useProject.getState().doc);
    const clips = tl.clips.filter((c) => c.mediaId === poolMediaId(id)).sort((a, b) => a.start - b.start);
    if (clips.length) {
      useTimelineUi.setState({ selected: clips.map((c) => c.id) });
      seek(clips[0].start);
    } else useMedia.setState({ notice: "This file is not on the timeline." });
  };

  const onItemDrag = (e: React.DragEvent, it: MediaItem) => {
    e.dataTransfer.setData(POOL_MIME, it.id);
    e.dataTransfer.setData("text/plain", it.name);
    e.dataTransfer.effectAllowed = "copyMove";
    useTimelineUi.setState({ sourceId: it.id });
  };

  const badges = (it: MediaItem) => (
    <>
      {status[it.id] === "missing" && <Badge tone="red" title="The file is gone. Relink it to a copy.">Missing</Badge>}
      {status[it.id] === "needs-permission" && <Badge tone="yellow" title="Linked file: the browser needs your permission again">Linked</Badge>}
      {it.note && <Badge tone="yellow" title={it.note}>Needs convert</Badge>}
      {it.storage === "link" && status[it.id] === "ok" && <Badge tone="gray" title="Linked to the original file, not copied">Link</Badge>}
      {used.has(it.id) && <Badge tone="accent" title="Used in this project">In use</Badge>}
    </>
  );
  const fixButton = (it: MediaItem) =>
    status[it.id] === "missing" ? (
      <button className="rounded border border-red-500/50 px-1.5 text-[10px] text-red-300 hover:bg-red-500/10" onClick={(e) => (e.stopPropagation(), (relinkId.current = it.id), relinkRef.current?.click())}>
        Relink
      </button>
    ) : status[it.id] === "needs-permission" ? (
      <button className="rounded border border-yellow-500/50 px-1.5 text-[10px] text-yellow-300 hover:bg-yellow-500/10" onClick={(e) => (e.stopPropagation(), void useMedia.getState().grantAccess(it.id))}>
        Allow access
      </button>
    ) : null;

  const nameField = (it: MediaItem) =>
    renaming === it.id ? (
      <input
        autoFocus
        defaultValue={it.name}
        className="field !py-0.5 text-[12px]"
        onClick={(e) => e.stopPropagation()}
        onBlur={(e) => (useMedia.getState().rename(it.id, e.currentTarget.value), setRenaming(null))}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setRenaming(null);
        }}
      />
    ) : (
      <p className="truncate text-[12px] text-gray-200" title={it.name} onDoubleClick={() => setRenaming(it.id)}>
        {it.name}
      </p>
    );

  const tabs: { id: KindFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "video", label: "Video" },
    { id: "audio", label: "Audio" },
    { id: "image", label: "Images" },
    { id: "subtitle", label: "Subtitles" },
    { id: "font", label: "Fonts" },
  ];

  return (
    <div
      className={`flex h-full flex-col ${over ? "outline outline-2 -outline-offset-8 outline-dashed outline-accent/60" : ""}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setOver(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setOver(false);
        add(e.dataTransfer.files);
      }}
    >
      <input ref={fileRef} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => add(e.target.files)} />
      <input
        ref={relinkRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f && relinkId.current) void useMedia.getState().relink(relinkId.current, f);
          e.target.value = "";
        }}
      />

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-edge px-5 py-3">
        <h2 className="text-gradient mr-auto text-[19px] font-semibold tracking-tight">Media library</h2>
        <div role="tablist" aria-label="Filter by type" className="flex gap-0.5 rounded-lg bg-black/40 p-0.5">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={kind === t.id} onClick={() => setKind(t.id)} className={`rounded-md px-2 py-1 text-xs ${kind === t.id ? "bg-raised text-white" : "text-gray-400 hover:text-gray-200"}`}>
              {t.label}
            </button>
          ))}
        </div>
        <select className="field !w-auto !py-1 text-xs" value={usage} onChange={(e) => setUsage(e.target.value as UseFilter)} aria-label="Used or unused">
          <option value="all">Used and unused</option>
          <option value="used">Used only</option>
          <option value="unused">Unused only</option>
        </select>
        <input className="field !w-44 !py-1" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search media" />
        <div className="flex gap-0.5 rounded-lg bg-black/40 p-0.5" role="group" aria-label="View">
          {(["grid", "list"] as const).map((v) => (
            <button key={v} aria-pressed={view === v} onClick={() => setView(v)} className={`rounded-md px-2 py-1 text-xs capitalize ${view === v ? "bg-raised text-white" : "text-gray-400"}`}>
              {v}
            </button>
          ))}
        </div>
        {canLink() && (
          <button className="rounded-lg border border-edge px-3 py-1.5 text-xs text-gray-300 hover:bg-raised" onClick={() => void useMedia.getState().linkFiles(binId)} title="Keep a link to large files instead of copying them">
            Link files
          </button>
        )}
        <button className="btn-primary flex h-8 items-center gap-1.5 rounded-lg px-3.5 text-xs" onClick={() => fileRef.current?.click()}>
          <Icon name="plus" className="h-3.5 w-3.5" />
          Import
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        <BinList where={where} setWhere={setWhere} usedCount={used.size} />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="space-y-2 px-5 pt-3">
            <ImportStatus />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-5 pt-3">
            {items.length === 0 ? (
              <button
                onClick={() => fileRef.current?.click()}
                className="grid h-full min-h-[240px] w-full place-items-center rounded-2xl border border-dashed border-white/20 text-center text-gray-400 hover:border-accent/50 hover:text-gray-200"
              >
                <span className="space-y-2">
                  <Icon name="import" className="mx-auto h-8 w-8" />
                  <span className="block text-sm">Drop video, audio, images, subtitles or fonts here, or click to choose files</span>
                </span>
              </button>
            ) : shown.length === 0 ? (
              <p className="py-16 text-center text-sm text-gray-500">No files here.</p>
            ) : view === "grid" ? (
              <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))" }}>
                {shown.map((it) => (
                  <div
                    key={it.id}
                    draggable
                    onDragStart={(e) => onItemDrag(e, it)}
                    onClick={() => select(it.id)}
                    onContextMenu={(e) => (e.preventDefault(), setMenu({ x: e.clientX, y: e.clientY, id: it.id }))}
                    className={`cursor-pointer overflow-hidden rounded-lg border ${sourceId === it.id ? "border-accent ring-1 ring-accent" : "border-edge"} bg-black/20 hover:border-accent/50`}
                    aria-selected={sourceId === it.id}
                    role="option"
                  >
                    <div className="relative aspect-video bg-black/40">
                      <PoolThumb item={it} />
                      <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] capitalize text-gray-200">
                        {it.kind}
                        {it.duration !== undefined ? `, ${mmss(it.duration)}` : ""}
                      </span>
                      <span className="absolute right-1 top-1 flex flex-wrap justify-end gap-0.5">{badges(it)}</span>
                    </div>
                    <div className="space-y-0.5 p-2">
                      {nameField(it)}
                      <p className="flex items-center justify-between gap-1 text-[10px] text-gray-500">
                        <span className="truncate">
                          {[it.width && `${it.width}x${it.height}`, it.fps && `${it.fps} fps`, size(it.size)].filter(Boolean).join(" · ")}
                        </span>
                        {fixButton(it)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <table className="w-full text-left text-[12px]">
                <thead className="text-[11px] text-gray-500">
                  <tr>
                    <th className="w-12 py-1" />
                    <th className="py-1">Name</th>
                    <th>Type</th>
                    <th>Duration</th>
                    <th>Size</th>
                    <th>Frame rate</th>
                    <th>Codecs</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((it) => (
                    <tr
                      key={it.id}
                      draggable
                      onDragStart={(e) => onItemDrag(e, it)}
                      onClick={() => select(it.id)}
                      onContextMenu={(e) => (e.preventDefault(), setMenu({ x: e.clientX, y: e.clientY, id: it.id }))}
                      className={`cursor-pointer border-t border-edge ${sourceId === it.id ? "bg-accent/15" : "hover:bg-white/[0.03]"}`}
                      aria-selected={sourceId === it.id}
                    >
                      <td className="py-1">
                        <div className="h-7 w-11 overflow-hidden rounded">
                          <PoolThumb item={it} />
                        </div>
                      </td>
                      <td className="max-w-[260px] py-1 pr-2">{nameField(it)}</td>
                      <td className="capitalize text-gray-400">{it.kind}</td>
                      <td className="tabular-nums text-gray-400">{mmss(it.duration)}</td>
                      <td className="tabular-nums text-gray-400">{it.width ? `${it.width}x${it.height}` : size(it.size)}</td>
                      <td className="tabular-nums text-gray-400">{it.fps ? `${it.fps}` : ""}</td>
                      <td className="text-gray-500">{[it.videoCodec, it.audioCodec].filter(Boolean).join(" / ")}</td>
                      <td className="space-x-1 whitespace-nowrap text-right">
                        {badges(it)} {fixButton(it)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {selected && <SourceStrip item={selected} />}
        </div>
      </div>

      {menu && (
        <PoolMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={(() => {
            const it = items.find((i) => i.id === menu.id);
            if (!it) return [];
            const targets = bins.filter((b) => b.id !== it.binId);
            return [
              { label: "Use as edit source", onClick: () => useTimelineUi.setState({ sourceId: it.id }) },
              { label: "Rename", onClick: () => setRenaming(it.id) },
              { label: "Reveal in timeline", onClick: () => reveal(it.id) },
              { label: "Relink to another file", onClick: () => ((relinkId.current = it.id), relinkRef.current?.click()) },
              ...(it.binId ? [{ label: "Move out of bin", onClick: () => useMedia.getState().moveToBin([it.id], undefined) }] : []),
              ...targets.map((b) => ({ label: `Move to ${b.name}`, onClick: () => useMedia.getState().moveToBin([it.id], b.id) })),
              { label: "Import media", onClick: () => fileRef.current?.click() },
              { label: used.has(it.id) ? "Remove (still used in the project)" : "Remove from library", danger: true, onClick: () => useMedia.getState().remove(it.id) },
            ];
          })()}
        />
      )}
    </div>
  );
}

function Badge({ tone, title, children }: { tone: "red" | "yellow" | "gray" | "accent"; title: string; children: string }) {
  const cls = { red: "bg-red-600 text-white", yellow: "bg-yellow-400 text-black", gray: "bg-black/70 text-gray-200", accent: "bg-accent text-black" }[tone];
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${cls}`} title={title}>
      {children}
    </span>
  );
}

/** Bins: smart bins on top, then the user's folders. Items can be dropped on a bin. */
function BinList({ where, setWhere, usedCount }: { where: Where; setWhere: (w: Where) => void; usedCount: number }) {
  const bins = useMedia((s) => s.bins);
  const items = useMedia((s) => s.items);
  const [editing, setEditing] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const smart: { id: SmartBin; label: string; count: number }[] = [
    { id: "all", label: "All media", count: items.length },
    { id: "video", label: "All video", count: items.filter((i) => i.kind === "video").length },
    { id: "audio", label: "All audio", count: items.filter((i) => i.kind === "audio").length },
    { id: "image", label: "All images", count: items.filter((i) => i.kind === "image").length },
    { id: "unused", label: "Unused", count: Math.max(0, items.length - usedCount) },
  ];
  const depth = (id: string): number => {
    const b = bins.find((x) => x.id === id);
    return b?.parentId ? 1 + depth(b.parentId) : 0;
  };
  const ordered = (parent?: string): typeof bins => bins.filter((b) => b.parentId === parent).flatMap((b) => [b, ...ordered(b.id)]);
  const row = (on: boolean) => `flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] ${on ? "bg-raised text-white" : "text-gray-400 hover:bg-white/5 hover:text-gray-200"}`;
  const dropProps = (binId: string | undefined, key: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(POOL_MIME)) return;
      e.preventDefault();
      setDropOn(key);
    },
    onDragLeave: () => setDropOn(null),
    onDrop: (e: React.DragEvent) => {
      const id = e.dataTransfer.getData(POOL_MIME);
      if (!id) return;
      e.preventDefault();
      setDropOn(null);
      useMedia.getState().moveToBin([id], binId);
    },
  });
  return (
    <nav className="w-48 shrink-0 space-y-3 overflow-y-auto border-r border-edge p-3" aria-label="Bins">
      <div className="space-y-0.5">
        <p className="px-2 text-[10px] uppercase tracking-wide text-gray-600">Smart bins</p>
        {smart.map((s) => (
          <button key={s.id} className={`${row("smart" in where && where.smart === s.id)} ${dropOn === s.id ? "ring-1 ring-accent" : ""}`} onClick={() => setWhere({ smart: s.id })} {...(s.id === "all" ? dropProps(undefined, s.id) : {})}>
            <span className="flex-1 truncate">{s.label}</span>
            <span className="text-[10px] text-gray-600">{s.count}</span>
          </button>
        ))}
      </div>
      <div className="space-y-0.5">
        <p className="px-2 text-[10px] uppercase tracking-wide text-gray-600">Bins</p>
        {ordered(undefined).map((b) => {
          const on = "bin" in where && where.bin === b.id;
          return (
            <div key={b.id} className="group relative" style={{ paddingLeft: depth(b.id) * 10 }} {...dropProps(b.id, b.id)}>
              {editing === b.id ? (
                <input
                  autoFocus
                  defaultValue={b.name}
                  className="field !py-0.5 text-[12px]"
                  onBlur={(e) => (useMedia.getState().renameBin(b.id, e.currentTarget.value), setEditing(null))}
                  onKeyDown={(e) => (e.key === "Enter" ? e.currentTarget.blur() : e.key === "Escape" && setEditing(null))}
                />
              ) : (
                <button className={`${row(on)} ${dropOn === b.id ? "ring-1 ring-accent" : ""}`} onClick={() => setWhere({ bin: b.id })} onDoubleClick={() => setEditing(b.id)} title="Double-click to rename. Drop files here to move them.">
                  <span>▸</span>
                  <span className="flex-1 truncate">{b.name}</span>
                  <span className="text-[10px] text-gray-600">{items.filter((i) => i.binId === b.id).length}</span>
                </button>
              )}
              <span className="absolute right-1 top-1 hidden gap-0.5 group-hover:flex">
                <button className="rounded px-1 text-[10px] text-gray-500 hover:text-gray-200" title="New bin inside" aria-label={`New bin inside ${b.name}`} onClick={() => setEditing(useMedia.getState().addBin("New bin", b.id))}>
                  +
                </button>
                <button
                  className="rounded px-1 text-[10px] text-gray-500 hover:text-red-400"
                  title="Delete bin (its files move up a level)"
                  aria-label={`Delete bin ${b.name}`}
                  onClick={() => {
                    useMedia.getState().deleteBin(b.id);
                    if (on) setWhere({ smart: "all" });
                  }}
                >
                  ✕
                </button>
              </span>
            </div>
          );
        })}
        <button className="w-full rounded-md px-2 py-1 text-left text-[12px] text-gray-500 hover:bg-white/5 hover:text-gray-200" onClick={() => setEditing(useMedia.getState().addBin("New bin"))}>
          + New bin
        </button>
      </div>
    </nav>
  );
}

/** Details of the chosen source and its in / out marks, used by insert, overwrite and the other edits. */
function SourceStrip({ item }: { item: MediaItem }) {
  const fps = useProject((s) => s.doc.settings.fps);
  const len = item.duration;
  const mark = (which: "markIn" | "markOut", v: string) => {
    const n = v.trim() === "" ? null : Number(v);
    if (n === null || Number.isFinite(n)) useMedia.getState().setMarks(item.id, { [which]: n === null ? null : Math.max(0, Math.min(len ?? Infinity, n)) });
  };
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-edge px-5 py-2 text-[11px] text-gray-400">
      <span className="font-medium text-gray-200">Source: {item.name}</span>
      {item.container && <span>{item.container}</span>}
      {item.videoCodec && <span>video {item.videoCodec}</span>}
      {item.audioCodec && <span>audio {item.audioCodec}{item.channels ? ` (${item.channels} ch)` : ""}</span>}
      {len !== undefined && <span>{timecode(len, fps)}</span>}
      {(item.kind === "video" || item.kind === "audio") && (
        <span className="flex items-center gap-1.5">
          In
          <input className="field !w-16 !py-0.5" type="number" step={0.04} min={0} value={item.markIn ?? ""} placeholder="start" onChange={(e) => mark("markIn", e.target.value)} aria-label="Source in (seconds)" />
          Out
          <input className="field !w-16 !py-0.5" type="number" step={0.04} min={0} value={item.markOut ?? ""} placeholder="end" onChange={(e) => mark("markOut", e.target.value)} aria-label="Source out (seconds)" />
        </span>
      )}
      {item.note && <span className="text-yellow-400">{item.note}</span>}
      <span className="ml-auto text-gray-500">Insert F9 · Overwrite F10 · Replace F11 · Place on top F12 · or drag onto a track</span>
    </div>
  );
}

function PoolMenu({ x, y, items, onClose }: { x: number; y: number; items: { label: string; onClick: () => void; danger?: boolean }[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ x: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), y: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) });
  }, [x, y]);
  useEffect(() => {
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", away, true);
    window.addEventListener("keydown", key, true);
    return () => (window.removeEventListener("mousedown", away, true), window.removeEventListener("keydown", key, true));
  }, [onClose]);
  return createPortal(
    <div ref={ref} role="menu" className="fixed z-[300] min-w-[200px] rounded-md border border-edge bg-panel py-1 text-xs shadow-2xl" style={{ left: pos.x, top: pos.y }}>
      {items.map((it, i) => (
        <button key={i} role="menuitem" onClick={() => (it.onClick(), onClose())} className={`block w-full px-3 py-1.5 text-left hover:bg-raised ${it.danger ? "text-red-400" : "text-gray-200"}`}>
          {it.label}
        </button>
      ))}
    </div>,
    document.body
  );
}
