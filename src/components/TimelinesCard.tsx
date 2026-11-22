import { useState } from "react";
import { Card } from "./ui";
import { useProject } from "../store/project";
import { activeTimeline } from "../model/convert";
import { editTimeline, tlNow, useTimelineUi } from "../timeline/ui";
import * as E from "../timeline/compound";
import { getTime } from "../lib/transport";
import { openTimeline, useNest } from "../lib/freeze";
import { useMedia } from "../store/media";
import { poolMediaId } from "../timeline/ui";
import { overwriteEdit, targetTrack } from "../timeline/engine";
import type { Aspect } from "../store/project";

const btn = "rounded-md border border-edge px-2 py-0.5 text-[11px] text-gray-300 hover:bg-white/10 disabled:opacity-40";

/** The breadcrumb above the timeline when a nested clip has been opened. */
export function Breadcrumb() {
  const trail = useNest((s) => s.trail);
  const doc = useProject((s) => s.doc);
  if (!trail.length) return null;
  const name = (id: string) => doc.timelines.find((t) => t.id === id)?.name ?? "?";
  return (
    <nav className="flex flex-wrap items-center gap-1 border-b border-edge bg-panel px-3 py-1 text-[12px] text-gray-300" aria-label="Timeline levels">
      {trail.map((id) => (
        <span key={id} className="flex items-center gap-1">
          <button className="rounded px-1 hover:bg-white/10" onClick={() => openTimeline(id)}>{name(id)}</button>
          <span className="text-gray-600">›</span>
        </span>
      ))}
      <span className="font-medium text-gray-100">{name(doc.activeTimelineId)}</span>
      <button className={`${btn} ml-2`} onClick={() => openTimeline(trail[trail.length - 1])}>Up a level</button>
    </nav>
  );
}

/** Timelines (phase 23): compound clips, placing timelines on others, versions in another frame shape, and subclips. */
export default function TimelinesCard() {
  const doc = useProject((s) => s.doc);
  const selected = useTimelineUi((s) => s.selected);
  const items = useMedia((s) => s.items);
  const [msg, setMsg] = useState("");
  const [subName, setSubName] = useState("");
  const [subMedia, setSubMedia] = useState("");
  const tl = activeTimeline(doc);
  const clip = selected.length === 1 ? tl.clips.find((c) => c.id === selected[0]) : undefined;
  const editDoc = useProject.getState().editDoc;
  const placeableList = E.placeable(doc, tl.id);
  const used = (id: string) => doc.timelines.some((t) => t.clips.some((c) => c.timelineId === id));

  const compound = () => {
    let out: ReturnType<typeof E.makeCompound> = null;
    editDoc((d) => {
      out = E.makeCompound(d, selected, "Compound clip");
      return out?.doc ?? d;
    });
    setMsg(out ? "Made a compound clip. Select it and choose Open to edit inside." : "Select clips on unlocked tracks first.");
  };
  const version = (aspect: Aspect) => {
    let made: string | null = null;
    editDoc((d) => {
      const dup = E.duplicateTimeline(d, d.activeTimelineId, `${tl.name} ${aspect}`);
      if (!dup) return d;
      made = dup.timelineId;
      return E.reframeTimeline(dup.doc, dup.timelineId, aspect) ?? dup.doc;
    });
    if (made) {
      openTimeline(made);
      setMsg(`Made a ${aspect} version. Picture clips fill the new frame; adjust the crop with position keyframes.`);
    }
  };
  const marksOf = (id: string) => items.find((i) => i.id === id);
  const fromMarks = () => {
    const item = marksOf(subMedia);
    if (!item || item.markIn === undefined || item.markOut === undefined) return setMsg("Set in and out marks on the media in the pool first.");
    editDoc((d) => E.makeSubclip(d, subName || `${item.name} ${item.markIn!.toFixed(1)}-${item.markOut!.toFixed(1)}`, poolMediaId(item.id), item.markIn!, item.markOut!) ?? d);
    setSubName("");
  };
  const fromClip = () => {
    if (!clip?.mediaId) return;
    editDoc((d) => E.makeSubclip(d, subName || `${clip.name ?? "Subclip"} ${clip.sourceIn.toFixed(1)}-${clip.sourceOut.toFixed(1)}`, clip.mediaId!, Math.min(clip.sourceIn, clip.sourceOut), Math.max(clip.sourceIn, clip.sourceOut)) ?? d);
    setSubName("");
  };
  const place = (id: string) => {
    let ok = false;
    editDoc((d) => {
      const r = E.placeTimeline(d, id, getTime());
      ok = !!r;
      return r?.doc ?? d;
    });
    if (!ok) setMsg("That timeline cannot be placed here (it would contain itself).");
  };

  return (
    <Card title="Timelines" hint="Compound clips and placed timelines show another timeline as one clip: edit inside once and every use follows.">
      <div className="space-y-1">
        {doc.timelines.map((t) => (
          <div key={t.id} className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] ${t.id === tl.id ? "bg-accent/15 text-accent" : "text-gray-300"}`}>
            <span className="flex-1 truncate">{t.name}{t.aspect ? ` (${t.aspect})` : ""}</span>
            {t.id !== tl.id && <button className={btn} onClick={() => openTimeline(t.id)}>Open</button>}
            {t.id !== tl.id && placeableList.some((p) => p.id === t.id) && <button className={btn} onClick={() => place(t.id)} title="Place at the playhead as one clip">Place</button>}
            {t.id !== tl.id && !used(t.id) && doc.timelines.length > 1 && <button className={btn} aria-label={`Delete ${t.name}`} onClick={() => editDoc((d) => ({ ...d, timelines: d.timelines.filter((x) => x.id !== t.id) }))}>×</button>}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-1">
        <button className={btn} disabled={!selected.length} onClick={compound}>Make compound clip</button>
        <button className={btn} disabled={!clip?.timelineId} onClick={() => clip?.timelineId && openTimeline(clip.timelineId, tl.id)}>Open selected</button>
        <button className={btn} disabled={!clip?.timelineId} onClick={() => clip && editDoc((d) => E.flattenNested(d, clip.id) ?? d)}>Flatten</button>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-[11px] text-gray-400">New version:</span>
        <button className={btn} onClick={() => version("9:16")}>9:16</button>
        <button className={btn} onClick={() => version("1:1")}>1:1</button>
        <button className={btn} onClick={() => editDoc((d) => E.duplicateTimeline(d, d.activeTimelineId)?.doc ?? d)}>Duplicate</button>
      </div>
      <div className="space-y-1 border-t border-edge pt-2">
        <div className="text-[12px] text-gray-300">Subclips</div>
        <input className="field !py-0.5" placeholder="Subclip name" value={subName} onChange={(e) => setSubName(e.target.value)} aria-label="Subclip name" />
        <div className="flex flex-wrap items-center gap-1">
          <select className="field !w-auto !py-0.5 text-[11px]" value={subMedia} onChange={(e) => setSubMedia(e.target.value)} aria-label="Media with marks">
            <option value="">Media with in and out marks...</option>
            {items.filter((i) => i.markIn !== undefined && i.markOut !== undefined && i.kind !== "subtitle").map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
          <button className={btn} disabled={!subMedia} onClick={fromMarks}>From marks</button>
          <button className={btn} disabled={!clip?.mediaId} onClick={fromClip}>From selected clip</button>
        </div>
        {(doc.subclips ?? []).map((s) => (
          <div key={s.id} className="flex items-center gap-1 text-[11px] text-gray-300">
            <span className="flex-1 truncate" title={`${s.in.toFixed(2)} to ${s.out.toFixed(2)} s`}>{s.name}</span>
            <button className={btn} onClick={() => placeSubclip(doc, s)}>Place</button>
            <button className={btn} aria-label={`Delete ${s.name}`} onClick={() => editDoc((d) => E.removeSubclip(d, s.id))}>×</button>
          </div>
        ))}
      </div>
      {msg && <p className="text-[11px] text-gray-400" role="status">{msg}</p>}
    </Card>
  );
}

/** Place a subclip at the playhead with the normal overwrite edit (the Timelines card and the media pool both use it). */
export function placeSubclip(doc: ReturnType<typeof useProject.getState>["doc"], s: Parameters<typeof E.subclipSource>[1]) {
  const src = E.subclipSource(doc, s);
  if (!src) return;
  const t = tlNow();
  const tr = { video: targetOf("video", t), audio: targetOf("audio", t) };
  editTimeline((x) => overwriteEdit(x, src, getTime(), tr).tl);
}

const targetOf = (kind: "video" | "audio", t: ReturnType<typeof tlNow>) => (targetTrack(t, kind) ?? t.tracks.find((x) => x.kind === kind))?.id;
