import { useEffect, useState } from "react";
import { Card } from "./ui";
import { useLibrary } from "../store/library";
import { useProject } from "../store/project";
import { useMedia } from "../store/media";
import { INTERVALS, useVersions } from "../store/versions";
import { useSync } from "../store/sync";
import { describeDiff, diffDocs, restoreDoc } from "../lib/versions";
import { exportTimeline, FORMATS, importTimeline, type ExportFormat } from "../lib/interchange";
import { download } from "../lib/interchange/common";
import type { Note } from "../lib/interchange/common";
import { buildPackage } from "../lib/storage/pack";
import { deviceStorage, formatBytes, projectUsage, type Usage } from "../lib/storage/usage";
import { getFile, listFiles, removeFile } from "../lib/filestore";
import { loadFile } from "../lib/assetdb";
import { downloadBlob } from "../lib/exporter";
import { seek, getTime } from "../lib/transport";

const btn = "rounded-lg border border-edge px-3 py-1.5 text-[13px] text-gray-300 hover:bg-raised hover:text-white disabled:opacity-40";
const link = "text-[11px] text-gray-400 underline hover:text-gray-100 disabled:opacity-40";
const when = (t: number) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const REASON: Record<string, string> = { auto: "Automatic", action: "Before a big change", manual: "Saved by you", restore: "Before a restore" };

/** Settings, Project data: storage, versions, packages, interchange, and optional sync and review (phase 29). */
export default function ProjectDataTab() {
  const open = useLibrary((s) => !!s.currentId);
  return (
    <div className="space-y-4">
      {!open && <p className="rounded-lg border border-edge bg-panel px-3 py-2 text-xs text-yellow-300">Open a project to use versions, interchange and sync. Storage and packages for the open project are listed here.</p>}
      <StorageCard />
      <VersionsCard />
      <PackageCard />
      <InterchangeCard />
      <SyncCard />
    </div>
  );
}

function Notes({ items }: { items: Note[] }) {
  if (!items.length) return null;
  return (
    <ul className="mt-2 space-y-1 text-xs" aria-label="What did not carry over">
      {items.map((n, i) => (
        <li key={i} className={n.level === "warn" ? "text-yellow-300" : "text-gray-400"}>{n.text}</li>
      ))}
    </ul>
  );
}

/* ---------- storage ---------- */

function poolOf(pid: string) {
  try {
    return JSON.parse(localStorage.getItem(`cutir:media:${pid}`) ?? "[]") as { id: string; name: string; storage?: "copy" | "link" }[];
  } catch {
    return [];
  }
}

function StorageCard() {
  const id = useLibrary((s) => s.currentId);
  const [dev, setDev] = useState<Awaited<ReturnType<typeof deviceStorage>>>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [note, setNote] = useState("");
  const [tick, setTick] = useState(0);
  const projectsSize = useLibrary((s) => s.entries).reduce((n, e) => n + (localStorage.getItem(`cutir:p:${e.id}`)?.length ?? 0), 0);

  useEffect(() => {
    void deviceStorage().then(setDev);
    if (!id) return setUsage(null);
    void listFiles(id).then((files) => setUsage(projectUsage(id, files, poolOf(id))));
  }, [id, tick]);

  const cleanUp = async () => {
    if (!id || !usage) return;
    for (const f of usage.orphans) await removeFile(f.key);
    setNote(`Removed ${usage.orphans.length} unused file${usage.orphans.length === 1 ? "" : "s"} (${formatBytes(usage.orphans.reduce((n, f) => n + f.size, 0))}).`);
    setTick((t) => t + 1);
  };
  const ask = async () => {
    setNote((await navigator.storage?.persist?.()) ? "The browser will keep this data unless you clear it yourself." : "The browser did not agree to keep the data permanently.");
    setTick((t) => t + 1);
  };

  return (
    <Card title="Storage" hint="Projects are saved in this browser: the project data in local storage with a second copy in the file store, media in the Origin Private File System.">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[13px] text-gray-300">
        <span>This browser is using</span>
        <span className="tabular-nums text-gray-400">{dev ? `${formatBytes(dev.used)} of ${formatBytes(dev.quota)}` : "Not available"}</span>
        <span>Project data (all projects)</span>
        <span className="tabular-nums text-gray-400">{formatBytes(projectsSize * 2)}</span>
        {dev && <><span>Kept permanently</span><span className="text-gray-400">{dev.persisted ? "Yes" : "No, the browser may clear it when space runs low"}</span></>}
      </div>
      {dev && !dev.persisted && <button className={`${btn} mt-2`} onClick={ask}>Ask the browser to keep it</button>}
      {id && usage && (
        <div className="mt-3 border-t border-edge/60 pt-3 text-[13px] text-gray-300">
          <p className="mb-1 font-medium">This project: {formatBytes(usage.total)}</p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-0.5 text-gray-400">
            <span>Media files</span><span className="tabular-nums">{formatBytes(usage.media)}</span>
            <span>Proxies</span><span className="tabular-nums">{formatBytes(usage.proxies)}</span>
            <span>Optimized copies</span><span className="tabular-nums">{formatBytes(usage.optimized)}</span>
            <span>Versions</span><span className="tabular-nums">{formatBytes(usage.versions)}</span>
            <span>Recovery copy</span><span className="tabular-nums">{formatBytes(usage.recovery)}</span>
          </div>
          {usage.items.some((i) => i.bytes > 0) && (
            <ul className="mt-2 max-h-40 divide-y divide-edge/60 overflow-y-auto text-[12px]" aria-label="Largest files">
              {usage.items.filter((i) => i.bytes > 0).slice(0, 12).map((i) => (
                <li key={i.id} className="flex justify-between gap-3 py-1">
                  <span className="truncate">{i.name}</span>
                  <span className="shrink-0 tabular-nums text-gray-500">{formatBytes(i.bytes)}</span>
                </li>
              ))}
            </ul>
          )}
          {usage.items.some((i) => i.linked) && <p className="mt-1 text-[11px] text-gray-500">Linked files stay where they are on disk and are not counted.</p>}
          <div className="mt-2 flex items-center gap-3">
            <button className={btn} disabled={!usage.orphans.length} onClick={cleanUp}>
              Remove unused files{usage.orphans.length ? ` (${formatBytes(usage.orphans.reduce((n, f) => n + f.size, 0))})` : ""}
            </button>
            <span className="text-[11px] text-gray-500">Files no media item points to, left over from deleted items.</span>
          </div>
        </div>
      )}
      {note && <p role="status" className="mt-2 text-xs text-yellow-300">{note}</p>}
    </Card>
  );
}

/* ---------- versions ---------- */

function VersionsCard() {
  const { list, every, projectId } = useVersions();
  const store = useVersions.getState();
  const [name, setName] = useState("");
  const [shown, setShown] = useState<{ id: string; lines: string[] } | null>(null);
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const ordered = [...list].reverse();

  const compare = (id: string) => {
    const snap = list.find((s) => s.id === id);
    if (!snap) return;
    const now = useProject.getState().doc;
    const lines = describeDiff(diffDocs(restoreDoc(snap, now), now));
    setShown({ id, lines: lines.length ? lines : ["No differences from the project as it is now."] });
  };

  return (
    <Card title="Versions" hint="Snapshots of the project. Automatic ones are taken while you work and before big changes. Named versions are kept until you delete them.">
      <div className="flex flex-wrap items-center gap-2">
        <input className="field !w-48" placeholder="Name this version" aria-label="Version name" value={name} onChange={(e) => setName(e.target.value)} />
        <button className={btn} disabled={!projectId} onClick={async () => (await store.take("manual", { name: name.trim() || undefined }), setName(""), setNote("Saved."))}>Save version</button>
        <button className={btn} disabled={!projectId} onClick={() => setNote(store.branch() ? "Copied the timeline as a branch and switched to it." : "Could not copy the timeline.")}>Branch this timeline</button>
        <label className="ml-auto flex items-center gap-2 text-[12px] text-gray-400">
          Automatic every
          <select className="field !w-auto" value={every} onChange={(e) => store.setEvery(Number(e.target.value))} aria-label="Minutes between automatic versions">
            {INTERVALS.map((m) => <option key={m} value={m}>{m === 0 ? "never" : `${m} min`}</option>)}
          </select>
        </label>
      </div>
      {note && <p role="status" className="mt-2 text-xs text-yellow-300">{note}</p>}
      {ordered.length === 0 && <p className="mt-2 text-xs text-gray-500">No versions yet.</p>}
      <ul className="mt-3 max-h-72 divide-y divide-edge/60 overflow-y-auto" aria-label="Versions">
        {ordered.map((s) => (
          <li key={s.id} className="py-2 text-[13px] text-gray-300">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="min-w-0 flex-1 truncate">
                {s.name ? <b className="font-medium text-white">{s.name}</b> : <span>{s.label ?? REASON[s.reason]}</span>}
                <span className="ml-2 text-[11px] text-gray-500">{when(s.at)} · {s.clips} clip{s.clips === 1 ? "" : "s"}</span>
              </span>
              <button className={link} onClick={() => (shown?.id === s.id ? setShown(null) : compare(s.id))}>{shown?.id === s.id ? "Hide changes" : "Compare"}</button>
              {confirm === s.id ? (
                <>
                  <button className="text-[11px] text-yellow-300 underline" onClick={async () => (await store.restore(s.id), setConfirm(null), setNote("Restored. Ctrl+Z undoes it."))}>Restore now</button>
                  <button className={link} onClick={() => setConfirm(null)}>Cancel</button>
                </>
              ) : (
                <button className={link} onClick={() => setConfirm(s.id)}>Restore</button>
              )}
              <button className={link} onClick={() => { const n = window.prompt("Name for this version", s.name ?? ""); if (n !== null) void store.rename(s.id, n); }}>Rename</button>
              <button className="text-[11px] text-red-300 underline hover:text-red-200" onClick={() => void store.remove(s.id)}>Delete</button>
            </div>
            {shown?.id === s.id && (
              <ul className="mt-1.5 space-y-0.5 pl-3 text-[12px] text-gray-400" aria-label="Changes since this version">
                {shown.lines.map((l, i) => <li key={i}>{l}</li>)}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* ---------- package ---------- */

function PackageCard() {
  const id = useLibrary((s) => s.currentId);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");

  const exportIt = async () => {
    if (!id) return;
    setBusy("Packing...");
    setNote("");
    try {
      const media = useMedia.getState();
      const doc = useProject.getState().doc;
      const name = useLibrary.getState().entries.find((e) => e.id === id)?.name ?? "project";
      const out = await buildPackage({
        name,
        doc,
        items: media.items as never,
        bins: media.bins,
        readFile: (it) => media.fileOf(it.id),
        readSlot: async (k) => (await getFile(`${id}/${k}`))?.slice() ?? (await loadFile(`${id}/${k}`))?.blob ?? null,
        onProgress: (d, t) => setBusy(`Packing ${d} of ${t}...`),
      });
      downloadBlob(out.blob, `${name.replace(/[^\w.-]+/g, "_")}.cutirpack.zip`);
      setNote(`Package saved (${formatBytes(out.bytes)}).${out.missing.length ? ` Left out because they could not be read: ${out.missing.slice(0, 5).join(", ")}${out.missing.length > 5 ? ", ..." : ""}.` : ""}`);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const importIt = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip,application/zip";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      setBusy("Opening...");
      try {
        const damaged = await useLibrary.getState().importPackage(f);
        setNote(damaged.length ? `Opened as a new project. These files were damaged in the package and were not restored: ${damaged.join(", ")}.` : "Opened as a new project.");
      } catch (e) {
        setNote((e as Error).message);
      } finally {
        setBusy("");
      }
    };
    input.click();
  };

  return (
    <Card title="Project package" hint="One zip with the project, its media pool and every media file. Use it for a backup or to move a project to another computer.">
      <div className="flex flex-wrap gap-2">
        <button className={btn} disabled={!id || !!busy} onClick={exportIt}>Save package</button>
        <button className={btn} disabled={!!busy} onClick={importIt}>Open package</button>
      </div>
      <p role="status" className="mt-2 text-xs text-yellow-300">{busy || note}</p>
      <p className="mt-1 text-[11px] text-gray-500">Linked files are copied into the package. A package cannot hold a single file over 4 GB.</p>
    </Card>
  );
}

/* ---------- interchange ---------- */

function InterchangeCard() {
  const open = useLibrary((s) => !!s.currentId);
  const [format, setFormat] = useState<ExportFormat>("otio");
  const [report, setReport] = useState<Note[]>([]);
  const [title, setTitle] = useState("");

  const doExport = () => {
    const doc = useProject.getState().doc;
    const tl = doc.timelines.find((t) => t.id === doc.activeTimelineId) ?? doc.timelines[0];
    const r = exportTimeline(doc, tl, format);
    download(r.filename, r.text, r.type);
    setTitle(`Exported ${r.filename}. Mapping report:`);
    setReport(r.report.length ? r.report : [{ level: "info", text: "Everything on the video and audio tracks went across." }]);
  };

  const doImport = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".otio,.edl,.json,.fcpxml,.xml";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        const doc = useProject.getState().doc;
        const r = importTimeline(doc, f.name, await f.text());
        await useVersions.getState().take("action", { label: "Before an import" });
        useProject.getState().editDoc(() => r.doc);
        useProject.getState().setActiveTimeline(r.timelineId);
        setTitle(`Imported ${f.name} as a new timeline. Mapping report:`);
        setReport(r.report);
      } catch (e) {
        setTitle("Could not import.");
        setReport([{ level: "warn", text: (e as Error).message }]);
      }
    };
    input.click();
  };

  const fmt = FORMATS.find((f) => f.id === format)!;
  return (
    <Card title="Move an edit to another editor" hint="Send the active timeline to DaVinci Resolve, Premiere or Final Cut, or bring one in. Cuts, speed, tracks and markers go across; the report lists everything that does not.">
      <div className="flex flex-wrap items-center gap-2">
        <select className="field !w-auto" value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)} aria-label="Export format">
          {FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
        <button className={btn} disabled={!open} onClick={doExport}>Export timeline</button>
        <button className={btn} disabled={!open} onClick={doImport}>Import .otio or .edl</button>
      </div>
      <p className="mt-1 text-[11px] text-gray-500">{fmt.note} Subtitles import and export from the Captions panel.</p>
      {title && <p role="status" className="mt-2 text-xs text-gray-300">{title}</p>}
      <Notes items={report} />
    </Card>
  );
}

/* ---------- sync and review ---------- */

function SyncCard() {
  const s = useSync();
  const open = useLibrary((x) => !!x.currentId);
  const [url, setUrl] = useState(s.url);
  const [token, setToken] = useState(s.token);
  const [text, setText] = useState("");
  const [author, setAuthor] = useState("");
  const connected = !!s.session;
  const configured = !!s.url && !!s.token;

  return (
    <Card title="Sync and review (optional)" hint="Off unless you set up a server. Cutir works fully without one. The reference service is in the sync-server folder: node sync-server/server.mjs --add-user yourname.">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="text-[11px] text-gray-400">
          Server address
          <input className="field mt-1" placeholder="https://sync.example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label className="text-[11px] text-gray-400">
          Access token
          <input className="field mt-1" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
        </label>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button className={btn} onClick={() => s.configure(url, token)}>Save</button>
        <button className={btn} disabled={!configured} onClick={() => (s.disconnect(), setUrl(""), setToken(""))}>Turn sync off</button>
        <span className="mx-1 border-l border-edge" />
        <button className={btn} disabled={!configured || !open || s.busy} onClick={() => void s.upload()}>Upload this project</button>
        <button className={btn} disabled={!configured || !open || s.busy} onClick={() => void s.download()}>Take the server version</button>
        <button className={btn} disabled={!connected || s.busy} onClick={() => void s.syncNow()}>Sync now</button>
      </div>
      <p role="status" className="mt-2 text-xs text-yellow-300">{s.status}</p>
      {s.conflicts.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-xs text-yellow-200" aria-label="Edits that could not be merged">
          {s.conflicts.map((c, i) => <li key={i}>{c}</li>)}
        </ul>
      )}
      {configured && open && (
        <div className="mt-3 border-t border-edge/60 pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[13px] font-medium text-gray-300">Review</p>
            <button className={btn} disabled={s.busy} onClick={() => void s.createReview()}>Create a review link</button>
            <button className={btn} disabled={s.busy} onClick={() => void s.refreshComments()}>Load comments</button>
          </div>
          {s.reviewUrl && (
            <p className="mt-1.5 break-all text-xs text-gray-300">
              <input className="field" readOnly aria-label="Review link" value={s.reviewUrl} onFocus={(e) => e.currentTarget.select()} />
              <span className="mt-1 block text-[11px] text-gray-500">The page shows the changes list and takes comments pinned to a time. The reviewer opens the video from their own computer; no video is uploaded.</span>
            </p>
          )}
          <form
            className="mt-2 flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) void s.addComment(text.trim(), author, getTime()).then(() => setText(""));
            }}
          >
            <input className="field !w-28" placeholder="Your name" aria-label="Your name" value={author} onChange={(e) => setAuthor(e.target.value)} />
            <input className="field min-w-0 flex-1" placeholder="Comment at the playhead" aria-label="Comment" value={text} onChange={(e) => setText(e.target.value)} />
            <button className={btn} disabled={!text.trim() || s.busy}>Add</button>
          </form>
          <ul className="mt-2 max-h-56 divide-y divide-edge/60 overflow-y-auto" aria-label="Comments">
            {[...s.comments].sort((a, b) => a.time - b.time).map((c) => (
              <li key={c.id} className={`flex items-start gap-2 py-1.5 text-[13px] ${c.resolved ? "text-gray-500" : "text-gray-300"}`}>
                <button className="w-12 shrink-0 text-left tabular-nums text-blue-300 underline" onClick={() => seek(c.time)} aria-label={`Go to ${mmss(c.time)}`}>{mmss(c.time)}</button>
                <span className="min-w-0 flex-1">
                  <b className="font-medium">{c.author}</b>: <span className={c.resolved ? "line-through" : ""}>{c.text}</span>
                  {c.resolved && c.resolvedBy ? <span className="ml-1 text-[11px]">(resolved by {c.resolvedBy})</span> : null}
                </span>
                <button className={link} onClick={() => void s.resolve(c.id, !c.resolved)}>{c.resolved ? "Reopen" : "Resolve"}</button>
              </li>
            ))}
          </ul>
          {!s.comments.length && <p className="mt-1 text-xs text-gray-500">No comments loaded.</p>}
        </div>
      )}
    </Card>
  );
}
