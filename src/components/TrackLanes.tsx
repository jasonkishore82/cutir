import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useProject } from "../store/project";
import { useMedia, type MediaItem } from "../store/media";
import { activeTimeline } from "../model/convert";
import type { Clip, Timeline, Track } from "../model/types";
import type { EnergyCurve } from "../store/project";
import { getTime, seek } from "../lib/transport";
import * as E from "../timeline/engine";
import { variantFor } from "../lib/proxy";
import { DEFAULT_PROXY } from "../model/types";
import { getTransition, transitionWindow } from "../lib/effects";
import * as FX from "../timeline/effects";
import { EFFECT_MIME, TRANSITION_MIME } from "./EffectsPanel";
import { CURSOR, MODE_HINT, beatSnapOn, editCtx, editTimeline, sourceOf, tlNow, useTimelineUi, withPoolMedia } from "../timeline/ui";
import KeyLane, { LANE_H, shownLanes } from "./KeyLane";
import { focusClip, useKeyframeUi } from "../lib/keyframes/ui";
import { cutStrip } from "../lib/multicam";

/** Drag type used by the media pool. */
export const POOL_MIME = "application/x-cutir-media";
const SNAP_PX = 8;

type Gesture = {
  mode: E.PointerMode;
  clipId: string;
  x0: number;
  y0: number;
  tl0: Timeline;
  moved: boolean;
  trackId: string;
};
type Marquee = { x0: number; y0: number; x1: number; y1: number };
type Ghost = { trackId: string; start: number; len: number; name: string };

/**
 * Video and audio tracks of the active timeline (phase 13), with the editing tools of phase 14.
 * Lives inside the timeline's scroll area, under the lyric (subtitle) lanes, sharing their zoom (`pps`).
 * Only clips in view are rendered, so long timelines stay fast.
 */
export default function TrackLanes({ pps, width, gutter, scrollRef, setPps }: { pps: number; width: number; gutter: number; scrollRef: React.RefObject<HTMLDivElement | null>; setPps: (n: number) => void }) {
  const tl = useProject((s) => activeTimeline(s.doc));
  const { selected, guide } = useTimelineUi();
  const [view, setView] = useState({ t0: 0, t1: 60 });
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; clipId?: string; trackId?: string; time: number } | null>(null);
  const [hint, setHint] = useState<{ x: number; y: number; text: string } | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);

  const tracks = useMemo(() => E.displayOrder(tl).filter((t) => t.kind !== "subtitle"), [tl]);
  const clipMap = useMemo(() => new Map(tl.clips.map((c) => [c.id, c])), [tl]);
  const selTr = useTimelineUi((s) => s.selectedTransition);
  const video = tracks.filter((t) => t.kind === "video");
  const audio = tracks.filter((t) => t.kind === "audio");
  const sortedByTrack = useMemo(() => {
    const m = new Map<string, Clip[]>();
    for (const t of tracks) m.set(t.id, E.clipsOn(tl, t.id));
    return m;
  }, [tl, tracks]);
  const maxLen = useMemo(() => Math.max(1, ...tl.clips.filter(E.editable).map((c) => c.duration)), [tl]);
  const items = useMedia((s) => s.items);
  const proxyStored = useProject((s) => s.doc.settings.proxy);
  const proxyCfg = { ...DEFAULT_PROXY, ...(proxyStored ?? {}) };
  const anySolo = tracks.some((t) => t.solo && t.kind === "audio");
  const docMedia = useProject((s) => s.doc.media);
  const mediaEnergy = (id?: string) => (id ? docMedia.find((m) => m.id === id)?.analysis?.energy : undefined);

  /* ---------- keyframe lanes under the focused clip (phase 18) ---------- */
  const doc = useProject((s) => s.doc);
  const chosenLanes = useKeyframeUi((s) => s.shownLanes);
  const snapping = useTimelineUi((s) => s.snapping);
  const focus = focusClip(tl, selected);
  const keyLanes = useMemo(() => (focus ? shownLanes(focus, doc, chosenLanes) : []), [focus, doc, chosenLanes]);
  const extraOf = (t: Track) => (focus && focus.trackId === t.id ? keyLanes.length * LANE_H : 0);
  const rowH = (t: Track) => t.height + extraOf(t);

  /* ---------- visible window ---------- */
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const update = () => setView({ t0: Math.max(0, (sc.scrollLeft - gutter) / pps), t1: (sc.scrollLeft + sc.clientWidth) / pps });
    update();
    sc.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      sc.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [scrollRef, pps, gutter]);

  /* ---------- playhead over these lanes ---------- */
  useEffect(() => {
    let raf = 0;
    const frame = () => {
      if (head.current) head.current.style.transform = `translateX(${getTime() * pps}px)`;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [pps]);

  /* ---------- geometry ---------- */
  const rowTop = useMemo(() => {
    const m = new Map<string, number>();
    let y = 22; // "Video" label row
    const h = (t: Track) => t.height + (focus && focus.trackId === t.id ? keyLanes.length * LANE_H : 0);
    for (const t of video) (m.set(t.id, y), (y += h(t)));
    y += 22; // centre line + "Audio" label
    for (const t of audio) (m.set(t.id, y), (y += h(t)));
    m.set("__end", y);
    return m;
  }, [video, audio, focus, keyLanes.length]);
  const height = rowTop.get("__end")! + 6;

  const local = (e: { clientX: number; clientY: number }) => {
    const r = area.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, t: Math.max(0, (e.clientX - r.left) / pps) };
  };
  const trackAt = (y: number): Track | undefined => tracks.find((t) => y >= rowTop.get(t.id)! && y < rowTop.get(t.id)! + t.height);
  const kindIndex = (t: Track) => tracks.filter((x) => x.kind === t.kind).indexOf(t);

  const points = (exclude: string[], alt = false) => E.snapPoints(tlNow(), { playhead: getTime(), beats: beatSnapOn(alt) }, exclude, [view.t0, view.t1]);
  const thr = SNAP_PX / pps;

  /* ---------- clip gestures ---------- */
  const onClipDown = (e: React.PointerEvent, c: Clip) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const ui = useTimelineUi.getState();
    const st = useProject.getState();
    st.select(null); // lyric selection and clip selection are separate
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mode = E.pointerMode(tlNow(), c.id, e.clientX - box.left, (e.clientY - box.top) / box.height, pps, ui.tool);
    if (mode === "hand" || mode === "zoom") return onLaneDown(e); // same as on empty space
    if (mode === "blade") {
      editTimeline((t) => E.blade(t, local(e).t, [c.id]));
      return;
    }
    // selection: plain click selects (keeps a multi-selection when pressing a selected clip), Shift/Ctrl adds or toggles
    let sel = ui.selected;
    if (e.shiftKey || e.ctrlKey || e.metaKey) sel = sel.includes(c.id) ? sel.filter((x) => x !== c.id) : [...sel, c.id];
    else if (!sel.includes(c.id)) sel = [c.id];
    useTimelineUi.setState({ selected: E.withLinked(tlNow(), sel), mode });
    if (E.isLocked(tlNow(), c.trackId)) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    gesture.current = { mode, clipId: c.id, x0: e.clientX, y0: e.clientY, tl0: tlNow(), moved: false, trackId: c.trackId };
  };

  const onClipMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    if (!g.moved) {
      if (Math.abs(e.clientX - g.x0) < 3 && Math.abs(e.clientY - g.y0) < 3) return;
      g.moved = true;
      useProject.getState().beginGesture(); // the whole drag is one undo step
    }
    const ui = useTimelineUi.getState();
    const snap = ui.snapping !== e.altKey; // Alt flips snapping while held
    let dt = (e.clientX - g.x0) / pps;
    const ctx = editCtx();
    const c = g.tl0.clips.find((x) => x.id === g.clipId)!;
    const sel = E.withLinked(g.tl0, ui.selected.includes(c.id) ? ui.selected : [c.id]);
    let guideAt: number | undefined;
    const snapEdges = (edges: number[]) => {
      if (!snap) return;
      const r = E.snapDelta(edges, dt, E.snapPoints(g.tl0, { playhead: getTime(), beats: ui.beatSnap }, sel, [view.t0, view.t1]), thr);
      dt = r.dt;
      guideAt = r.at;
    };
    let next: Timeline;
    switch (g.mode) {
      case "move": {
        const group = g.tl0.clips.filter((x) => sel.includes(x.id));
        snapEdges(group.flatMap((x) => [x.start, E.clipEnd(x)]));
        const from = tracks.find((t) => t.id === g.trackId)!;
        const over = trackAt(local(e).y);
        const shift = over && over.kind === from.kind ? kindIndex(from) - kindIndex(over) : 0;
        next = E.moveClips(g.tl0, sel, dt, shift, from.kind);
        break;
      }
      case "trim-start":
      case "ripple-start":
        snapEdges([c.start]);
        next = E.trimEdge(g.tl0, c.id, "start", dt, g.mode === "ripple-start", ctx);
        break;
      case "trim-end":
      case "ripple-end":
        snapEdges([E.clipEnd(c)]);
        next = E.trimEdge(g.tl0, c.id, "end", dt, g.mode === "ripple-end", ctx);
        break;
      case "roll": {
        const track = E.clipsOn(g.tl0, c.trackId);
        const i = track.findIndex((x) => x.id === c.id);
        const atStart = local(e).x - c.start * pps < (c.duration * pps) / 2;
        const [L, R] = atStart ? [track[i - 1], c] : [c, track[i + 1]];
        if (!L || !R) return;
        snapEdges([R.start]);
        next = E.roll(g.tl0, L.id, R.id, dt, ctx);
        break;
      }
      case "slip":
        next = E.slip(g.tl0, c.id, -dt, ctx); // drag right = earlier source, like dragging the film
        break;
      case "slide":
        snapEdges([c.start, E.clipEnd(c)]);
        next = E.slide(g.tl0, c.id, dt, ctx);
        break;
      default:
        return;
    }
    useTimelineUi.setState({ guide: guideAt ?? null });
    useProject.getState().editDoc((doc) => E.onActive(doc, () => next));
  };

  const onClipUp = () => {
    const g = gesture.current;
    gesture.current = null;
    useTimelineUi.setState({ guide: null, mode: null });
    if (g?.moved) useProject.getState().endGesture();
  };

  /* ---------- lane gestures: marquee, hand, zoom, deselect ---------- */
  const onLaneDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const ui = useTimelineUi.getState();
    const p = local(e);
    if (ui.tool === "zoom") {
      const next = Math.min(300, Math.max(4, e.altKey ? pps / 1.5 : pps * 1.5));
      setPps(next);
      requestAnimationFrame(() => {
        const sc = scrollRef.current;
        if (sc) sc.scrollLeft = Math.max(0, p.t * next - sc.clientWidth / 2 + gutter);
      });
      return;
    }
    if (ui.tool === "hand") {
      const sc = scrollRef.current;
      if (!sc) return;
      const x0 = e.clientX;
      const s0 = sc.scrollLeft;
      const mv = (ev: PointerEvent) => (sc.scrollLeft = s0 - (ev.clientX - x0));
      const up = () => (window.removeEventListener("pointermove", mv), window.removeEventListener("pointerup", up));
      window.addEventListener("pointermove", mv);
      window.addEventListener("pointerup", up);
      return;
    }
    if (ui.tool === "blade") {
      const t = trackAt(p.y);
      if (t) editTimeline((x) => E.blade(x, p.t, E.clipsOn(x, t.id).map((c) => c.id)));
      return;
    }
    if (!e.shiftKey) useTimelineUi.setState({ selected: [] });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setMarquee({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };
  const onLaneMove = (e: React.PointerEvent) => {
    if (marquee) {
      const p = local(e);
      setMarquee({ ...marquee, x1: p.x, y1: p.y });
    }
  };
  const onLaneUp = (e: React.PointerEvent) => {
    if (!marquee) return;
    const m = marquee;
    setMarquee(null);
    if (Math.abs(m.x1 - m.x0) < 3 && Math.abs(m.y1 - m.y0) < 3) {
      seek(m.x0 / pps); // a click on empty space moves the playhead
      return;
    }
    const [ya, yb] = [Math.min(m.y0, m.y1), Math.max(m.y0, m.y1)];
    const ids = tracks.filter((t) => rowTop.get(t.id)! < yb && rowTop.get(t.id)! + t.height > ya).map((t) => t.id);
    const hit = E.clipsInRange(tlNow(), m.x0 / pps, m.x1 / pps, ids);
    const base = e.shiftKey ? useTimelineUi.getState().selected : [];
    useTimelineUi.setState({ selected: E.withLinked(tlNow(), [...new Set([...base, ...hit])]) });
  };

  /* ---------- pointer-mode hint (cursor + tooltip) ---------- */
  const onClipHover = (e: React.PointerEvent, c: Clip) => {
    if (gesture.current) return;
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mode = E.pointerMode(tlNow(), c.id, e.clientX - box.left, (e.clientY - box.top) / box.height, pps, useTimelineUi.getState().tool);
    (e.currentTarget as HTMLElement).style.cursor = E.isLocked(tlNow(), c.trackId) ? "not-allowed" : CURSOR[mode];
    setHint({ x: e.clientX + 12, y: e.clientY + 14, text: E.isLocked(tlNow(), c.trackId) ? "Track is locked" : MODE_HINT[mode] });
  };

  /* ---------- drop from the media pool or the desktop ---------- */
  const dropSource = (e: React.DragEvent): MediaItem | undefined => {
    const id = e.dataTransfer.getData(POOL_MIME) || (e.dataTransfer.types.includes(POOL_MIME) ? useTimelineUi.getState().sourceId : null);
    return id ? useMedia.getState().items.find((i) => i.id === id) : undefined;
  };
  const placeAt = (e: React.DragEvent, item: MediaItem) => {
    const p = local(e);
    const over = trackAt(p.y);
    const kind = item.kind === "audio" ? "audio" : "video";
    const track = over && over.kind === kind && !over.locked ? over : E.targetTrack(tlNow(), kind);
    const src = sourceOf(item);
    if (!track || !src) return null;
    let start = p.t;
    const len = src.out - src.in;
    if (useTimelineUi.getState().snapping !== e.altKey) start = start + E.snapDelta([start, start + len], 0, points([], e.altKey), thr).dt;
    return { track, src, start: Math.max(0, start), len };
  };
  const onDragOver = (e: React.DragEvent) => {
    const types = e.dataTransfer.types;
    if (types.includes(EFFECT_MIME) || types.includes(TRANSITION_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      return;
    }
    if (!types.includes(POOL_MIME) && !types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const item = dropSource(e);
    const at = item && placeAt(e, item);
    setGhost(at ? { trackId: at.track.id, start: at.start, len: at.len, name: item!.name } : null);
  };
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setGhost(null);
    // an effect: onto the clip under the pointer, or onto every clip of the track
    const fxId = e.dataTransfer.getData(EFFECT_MIME);
    if (fxId) {
      const clipEl = (e.target as HTMLElement).closest("[data-clip-id]") as HTMLElement | null;
      const doc = useProject.getState().doc;
      const track = trackAt(local(e).y);
      const ids = clipEl ? [clipEl.dataset.clipId!] : track ? E.clipsOn(tlNow(), track.id).map((c) => c.id) : [];
      const targets = FX.effectTargets(tlNow(), doc, ids);
      if (targets.length) editTimeline((t) => FX.addEffect(t, targets, fxId));
      return;
    }
    // a transition: onto the nearest cut or clip edge of the track
    const trType = e.dataTransfer.getData(TRANSITION_MIME);
    if (trType) {
      const track = trackAt(local(e).y);
      const place = track && FX.placeAt(tlNow(), track.id, local(e).t, 16 / pps);
      if (track && place) editTimeline((t) => FX.addTransition(t, { trackId: track.id, ...place, type: track.kind === "audio" ? "crossfade" : trType }));
      return;
    }
    let item = dropSource(e);
    if (!item && e.dataTransfer.files.length) {
      const added = await useMedia.getState().addFiles(Array.from(e.dataTransfer.files));
      item = added.find((i) => i.kind === "video" || i.kind === "audio" || i.kind === "image");
    }
    if (!item) return;
    const at = placeAt(e, item);
    if (!at) return;
    const audioTarget = at.track.kind === "video" ? E.targetTrack(tlNow(), "audio")?.id : at.track.id;
    const it = item;
    useProject.getState().editDoc((doc) =>
      E.onActive(withPoolMedia(doc, it), (t) => {
        const r = E.overwriteEdit(t, at.src, at.start, at.track.kind === "video" ? { video: at.track.id, audio: audioTarget } : { audio: at.track.id });
        useTimelineUi.setState({ selected: r.ids });
        return r.tl;
      })
    );
  };

  /* ---------- header actions ---------- */
  const setT = (id: string, patch: Partial<Track>) => editTimeline((t) => E.setTrack(t, id, patch));
  const addT = (kind: "video" | "audio") => editTimeline((t) => E.addTrack(t, kind).tl);

  const menuItems = (m: NonNullable<typeof menu>) => {
    const t = tlNow();
    const c = m.clipId ? t.clips.find((x) => x.id === m.clipId) : undefined;
    const ids = useTimelineUi.getState().selected;
    const items: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean }[] = [];
    if (c) {
      const track = E.clipsOn(t, c.trackId);
      const i = track.findIndex((x) => x.id === c.id);
      const next = track[i + 1];
      items.push(
        { label: "Cut at playhead", onClick: () => editTimeline((x) => E.blade(x, getTime(), [c.id])), disabled: getTime() <= c.start || getTime() >= E.clipEnd(c) },
        { label: "Join through edit with next", onClick: () => editTimeline((x) => E.joinThroughEdit(x, c.id, next!.id)), disabled: !next || E.joinThroughEdit(t, c.id, next.id) === t },
        { label: "Duplicate after itself", onClick: () => editTimeline((x) => E.duplicateClips(x, ids.length ? ids : [c.id], E.clipEnd(c)).tl) },
        { label: c.linkId ? "Unlink picture and sound" : "Link with clips under it", onClick: () => editTimeline((x) => toggleLink(x, c.id)) },
        { label: "Add marker on clip", onClick: () => editTimeline((x) => E.addMarker(x, getTime(), { clipId: c.id, color: "#facc15" }).tl) },
        { label: c.enabled ? "Disable clip" : "Enable clip", onClick: () => editTimeline((x) => ({ ...x, clips: x.clips.map((y) => (y.id === c.id ? { ...y, enabled: !y.enabled } : y)) })) },
        { label: "Delete (leave gap)", onClick: () => editTimeline((x) => E.deleteClips(x, ids.length ? ids : [c.id])), danger: true },
        { label: "Ripple delete", onClick: () => editTimeline((x) => E.rippleDelete(x, ids.length ? ids : [c.id])), danger: true }
      );
    } else if (m.trackId) {
      const tr = t.tracks.find((x) => x.id === m.trackId)!;
      items.push(
        { label: "Make insert target", onClick: () => editTimeline((x) => E.setTarget(x, tr.id)) },
        { label: `Add ${tr.kind} track`, onClick: () => addT(tr.kind as "video" | "audio") },
        { label: "Delete track", onClick: () => editTimeline((x) => E.removeTrack(x, tr.id)), danger: true, disabled: tr.locked || tr.id === "v-bg" || tr.id === "a-song" }
      );
    }
    return items;
  };

  const sel = new Set(selected);
  const label = "sticky left-0 z-20 flex shrink-0 items-center gap-1 border-r border-edge bg-panel px-2 text-[11px] text-gray-500";
  const hBtn = (on: boolean) => `grid h-5 min-w-5 place-items-center rounded px-1 text-[10px] font-semibold ${on ? "bg-accent/25 text-accent" : "text-gray-500 hover:bg-white/10 hover:text-gray-200"}`;

  const row = (t: Track) => {
    const clips = E.visibleClips(sortedByTrack.get(t.id) ?? [], view.t0, view.t1, maxLen);
    const fill = tl.clips.filter((c) => c.trackId === t.id && c.fill);
    const audible = t.kind !== "audio" || (!t.muted && (!anySolo || t.solo));
    return (
      <div key={t.id} className="flex border-b border-edge" style={{ height: rowH(t) }} data-testid="track">
        <div className={`${label} justify-between`} style={{ width: gutter }} onContextMenu={(e) => (e.preventDefault(), setMenu({ x: e.clientX, y: e.clientY, trackId: t.id, time: 0 }))}>
          <span className="flex min-w-0 items-center gap-1">
            <button className={hBtn(!!t.target)} title="Insert target: edits from the pool go here" aria-pressed={!!t.target} onClick={() => editTimeline((x) => E.setTarget(x, t.id))}>
              ◎
            </button>
            <span className={`truncate ${audible ? "text-gray-200" : "text-gray-500 line-through"}`} title={t.name}>{t.name}</span>
          </span>
          <span className="flex items-center gap-0.5">
            {t.kind === "video" ? (
              <button className={hBtn(t.hidden)} title={t.hidden ? "Show track" : "Hide track"} aria-pressed={t.hidden} onClick={() => setT(t.id, { hidden: !t.hidden })}>
                {t.hidden ? "◌" : "◉"}
              </button>
            ) : (
              <>
                <button className={hBtn(t.muted)} title="Mute" aria-pressed={t.muted} onClick={() => setT(t.id, { muted: !t.muted })}>M</button>
                <button className={hBtn(t.solo)} title="Solo" aria-pressed={t.solo} onClick={() => setT(t.id, { solo: !t.solo })}>S</button>
              </>
            )}
            <button className={hBtn(t.locked)} title={t.locked ? "Unlock" : "Lock"} aria-pressed={t.locked} onClick={() => setT(t.id, { locked: !t.locked })}>
              {t.locked ? "🔒" : "🔓"}
            </button>
            <button className={hBtn(false)} title="Move up" onClick={() => editTimeline((x) => E.moveTrack(x, t.id, x.tracks.filter((y) => y.kind === t.kind).findIndex((y) => y.id === t.id) + (t.kind === "audio" ? -1 : 1)))}>▲</button>
            <button className={hBtn(false)} title="Move down" onClick={() => editTimeline((x) => E.moveTrack(x, t.id, x.tracks.filter((y) => y.kind === t.kind).findIndex((y) => y.id === t.id) + (t.kind === "audio" ? 1 : -1)))}>▼</button>
          </span>
        </div>
        <div
          className={`relative self-start ${t.locked ? "bg-[repeating-linear-gradient(45deg,transparent,transparent_6px,rgb(var(--white)/0.03)_6px,rgb(var(--white)/0.03)_12px)]" : ""} ${t.hidden ? "opacity-50" : ""}`}
          style={{ width, height: t.height }}
          onPointerDown={(e) => e.target === e.currentTarget && onLaneDown(e)}
          onPointerMove={onLaneMove}
          onPointerUp={onLaneUp}
          onContextMenu={(e) => {
            if (e.target !== e.currentTarget) return;
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, trackId: t.id, time: local(e).t });
          }}
        >
          {fill.map((c) => {
            const energy = t.kind === "audio" ? mediaEnergy(c.mediaId) : undefined;
            return (
              <div key={c.id} className="pointer-events-none absolute inset-y-1 left-0 right-0 rounded border border-dashed border-edge bg-white/[0.03] px-2 text-[10px] leading-6 text-gray-500">
                {energy && <EnergyArea curve={energy} clip={{ ...c, start: 0, duration: view.t1 + 1 }} t0={view.t0} t1={view.t1} pps={pps} height={t.height - 10} />}
                <span className="relative">{c.id === "c-song" ? "Song (whole timeline)" : "Lyric background (whole timeline)"}</span>
              </div>
            );
          })}
          {clips.map((c) => {
            const on = sel.has(c.id);
            const media = useProject.getState().doc.media.find((m) => m.id === c.mediaId);
            return (
              <div
                key={c.id}
                data-clip-id={c.id}
                role="button"
                aria-pressed={on}
                aria-label={`${c.name ?? media?.name ?? "clip"}, ${c.start.toFixed(2)} to ${E.clipEnd(c).toFixed(2)} seconds`}
                onPointerDown={(e) => onClipDown(e, c)}
                onPointerMove={(e) => (gesture.current ? onClipMove(e) : onClipHover(e, c))}
                onPointerUp={onClipUp}
                onPointerCancel={onClipUp}
                onPointerLeave={() => setHint(null)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (!sel.has(c.id)) useTimelineUi.setState({ selected: E.withLinked(tlNow(), [c.id]) });
                  setMenu({ x: e.clientX, y: e.clientY, clipId: c.id, time: local(e).t });
                }}
                className={`absolute inset-y-1 select-none overflow-hidden rounded border text-[10px] touch-none ${
                  on ? "border-white ring-1 ring-accent" : "border-black/30"
                } ${t.kind === "audio" ? "bg-emerald-600/70" : media?.kind === "image" ? "bg-violet-600/70" : "bg-sky-600/70"} ${c.enabled ? "" : "opacity-40"}`}
                style={{ left: c.start * pps, width: Math.max(2, c.duration * pps) }}
              >
                {t.kind === "audio" && media?.analysis?.energy && (
                  <EnergyArea curve={media.analysis.energy} clip={c} t0={view.t0} t1={view.t1} pps={pps} height={t.height - 10} />
                )}
                <div className="relative flex items-center gap-1 truncate bg-black/25 px-1.5 leading-4 text-white">
                  {c.linkId && <span title="Linked">⛓</span>}
                  {(() => {
                    const it = media?.poolId ? items.find((i) => i.id === media.poolId) : undefined;
                    const v = it ? variantFor(it, "playback", proxyCfg) : "original";
                    return v === "original" ? null : (
                      <span className="rounded bg-black/40 px-0.5 font-semibold" title={v === "proxy" ? `Playing the ${it!.proxy!.height}p proxy; export uses the original` : "Playing the optimized copy; export uses the original"}>
                        {v === "proxy" ? "P" : "O"}
                      </span>
                    );
                  })()}
                  {media?.note && <span title={media.note}>⚠</span>}
                  {c.speed !== 1 && <span className="rounded bg-black/40 px-0.5">{Math.round(c.speed * 100)}%</span>}
                  {c.effects.length > 0 && <span className="rounded bg-black/40 px-0.5">fx</span>}
                  <span className="truncate">{c.name ?? media?.name ?? "clip"}</span>
                </div>
                <div className="relative px-1.5 text-[9px] text-white/70">{c.duration.toFixed(2)}s</div>
                {c.multicam && (
                  <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-3" aria-hidden>
                    {cutStrip(c.multicam, c).map((s, i) => (
                      <span key={i} className="absolute top-0 h-full overflow-hidden whitespace-nowrap border-l border-black/60 px-0.5 text-[8px] leading-3 text-black" style={{ left: s.from * pps, width: Math.max(1, (s.to - s.from) * pps), background: s.color }} title={`${s.name}${s.audioOnly ? `, sound from ${s.audioOnly}` : ""}`}>
                        {s.number}{s.audioOnly ? "♪" : ""}
                      </span>
                    ))}
                  </div>
                )}
                {tl.markers.filter((m) => m.clipId === c.id).map((m) => (
                  <span key={m.id} className="absolute bottom-0 h-1.5 w-1.5 rounded-full" style={{ left: (m.time - c.start) * pps - 3, background: m.color }} title={m.name || "Marker"} />
                ))}
              </div>
            );
          })}
          {(tl.cutTransitions ?? [])
            .filter((tr) => tr.trackId === t.id)
            .map((tr) => {
              const w = transitionWindow(tr, clipMap);
              if (!w) return null;
              const on = selTr === tr.id;
              const name = tr.type === "crossfade" ? "Crossfade" : getTransition(tr.type)?.name ?? tr.type;
              return (
                <button
                  key={tr.id}
                  className={`absolute bottom-1 z-[3] h-3 overflow-hidden rounded-sm border text-[8px] leading-[10px] ${on ? "border-yellow-300 bg-yellow-400/70 text-black" : "border-white/60 bg-black/60 text-white"}`}
                  style={{ left: w[0] * pps, width: Math.max(6, (w[1] - w[0]) * pps) }}
                  title={`${name}, ${tr.duration.toFixed(2)} s. Click to edit in the Effects tab; right-click to remove.`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => useTimelineUi.setState({ selectedTransition: tr.id })}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    editTimeline((x) => FX.removeTransition(x, tr.id));
                  }}
                >
                  {name}
                </button>
              );
            })}
          {extraOf(t) > 0 && focus && <KeyLane clip={focus} lanes={keyLanes} pps={pps} snapping={snapping} />}
          {ghost?.trackId === t.id && (
            <div className="pointer-events-none absolute inset-y-1 rounded border-2 border-dashed border-accent bg-accent/20 px-1 text-[10px] text-accent" style={{ left: ghost.start * pps, width: Math.max(4, ghost.len * pps) }}>
              {ghost.name}
            </div>
          )}
        </div>
        {/* resize the track height */}
        <span
          className="absolute left-0 h-1.5 cursor-row-resize"
          style={{ width: gutter, top: rowTop.get(t.id)! + rowH(t) - 3 }}
          onPointerDown={(e) => {
            e.preventDefault();
            const y0 = e.clientY;
            const h0 = t.height;
            const mv = (ev: PointerEvent) => editTimeline((x) => E.setTrack(x, t.id, { height: Math.max(28, Math.min(160, h0 + ev.clientY - y0)) }), `h:${t.id}`);
            const up = () => (window.removeEventListener("pointermove", mv), window.removeEventListener("pointerup", up));
            window.addEventListener("pointermove", mv);
            window.addEventListener("pointerup", up);
          }}
        />
      </div>
    );
  };

  return (
    <div className="relative" style={{ height }} onDragOver={onDragOver} onDragLeave={() => setGhost(null)} onDrop={onDrop}>
      <div className="flex h-[22px] border-b border-edge">
        <div className={label} style={{ width: gutter }}>
          <span className="uppercase tracking-wide">Video</span>
          <button className="ml-auto rounded px-1.5 text-gray-400 hover:bg-white/10" onClick={() => addT("video")} title="Add a video track">+ track</button>
        </div>
      </div>
      {video.map(row)}
      <div className="flex h-[22px] border-b-2 border-t border-edge">
        <div className={label} style={{ width: gutter }}>
          <span className="uppercase tracking-wide">Audio</span>
          <button className="ml-auto rounded px-1.5 text-gray-400 hover:bg-white/10" onClick={() => addT("audio")} title="Add an audio track">+ track</button>
        </div>
      </div>
      {audio.map(row)}

      {/* time area overlay: marquee, snap guide, range, playhead (offset past the header column) */}
      {/* coordinate reference for the time area (never takes pointer events) */}
      <div ref={area} className="pointer-events-none absolute bottom-0 top-0" style={{ left: gutter, width }} />
      <div className="pointer-events-none absolute bottom-0 top-0 z-10" style={{ left: gutter, width }}>
        {tl.inPoint !== undefined && tl.outPoint !== undefined && <div className="absolute inset-y-0 bg-accent/10" style={{ left: tl.inPoint * pps, width: (tl.outPoint - tl.inPoint) * pps }} />}
        {guide !== null && <div className="absolute inset-y-0 w-px bg-yellow-300" style={{ left: guide * pps }} />}
        {marquee && (
          <div
            className="absolute border border-accent bg-accent/10"
            style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }}
          />
        )}
        <div ref={head} className="absolute bottom-0 top-0 left-0 w-px bg-yellow-400" />
      </div>
      {hint && createPortal(<div className="pointer-events-none fixed z-[300] rounded bg-black/80 px-1.5 py-0.5 text-[10px] text-white" style={{ left: hint.x, top: hint.y }}>{hint.text}</div>, document.body)}
      {menu && <ClipMenu x={menu.x} y={menu.y} items={menuItems(menu)} onClose={() => setMenu(null)} />}
      {items.length === 0 && video.length + audio.length <= 2 && (
        <p className="pointer-events-none absolute right-3 top-1 text-[10px] text-gray-600">Drag files from the Media library onto a track</p>
      )}
    </div>
  );
}

/**
 * The outline of a loudness curve under a clip, as an SVG path in clip-local pixels (x from the clip's left edge,
 * y from the top, louder = higher). Source time is mapped through the clip's source in point and speed; only
 * [t0, t1] (timeline seconds) is traced, one point every `step` pixels, each the loudest value in its span.
 */
export function energyPath(curve: EnergyCurve, clip: Pick<Clip, "start" | "duration" | "sourceIn" | "speed">, t0: number, t1: number, pps: number, height: number, step = 2): string {
  const a = Math.max(t0, clip.start);
  const b = Math.min(t1, clip.start + clip.duration);
  if (b <= a || !curve.values.length || curve.rate <= 0) return "";
  const n = curve.values.length;
  const idx = (u: number) => (clip.sourceIn + (u - clip.start) * clip.speed) * curve.rate;
  const dt = step / pps;
  const x = (u: number) => ((u - clip.start) * pps).toFixed(1);
  let d = `M${x(a)},${height}`;
  for (let u = a; u <= b + dt / 2; u += dt) {
    const uu = Math.min(u, b);
    const i0 = Math.max(0, Math.floor(idx(uu - dt / 2)));
    const i1 = Math.min(n - 1, Math.ceil(idx(uu + dt / 2)));
    let v = 0;
    for (let i = i0; i <= i1; i++) v = Math.max(v, curve.values[i] ?? 0);
    if (i0 > n - 1) v = 0;
    d += `L${x(uu)},${(height * (1 - Math.min(1, Math.max(0, v)) * 0.9)).toFixed(1)}`;
  }
  return `${d}L${x(b)},${height}Z`;
}

/** The song's loudness as a soft filled area behind a clip's label (theme-aware: `--white` swaps in light mode). */
function EnergyArea({ curve, clip, t0, t1, pps, height }: { curve: EnergyCurve; clip: Pick<Clip, "start" | "duration" | "sourceIn" | "speed">; t0: number; t1: number; pps: number; height: number }) {
  const d = energyPath(curve, clip, t0, t1, pps, height);
  if (!d) return null;
  return (
    <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={1} height={height} aria-hidden>
      <path d={d} style={{ fill: "rgb(var(--white) / 0.16)", stroke: "rgb(var(--white) / 0.35)", strokeWidth: 1 }} />
    </svg>
  );
}

/** Link a clip with the clips under it on other tracks (same start and length), or unlink its group. */
function toggleLink(tl: Timeline, id: string): Timeline {
  const c = tl.clips.find((x) => x.id === id);
  if (!c) return tl;
  if (c.linkId) return { ...tl, clips: tl.clips.map((x) => (x.linkId === c.linkId ? { ...x, linkId: undefined } : x)) };
  const mates = tl.clips.filter((x) => x.id !== id && E.editable(x) && x.trackId !== c.trackId && Math.abs(x.start - c.start) < 1e-3 && Math.abs(x.duration - c.duration) < 1e-3);
  if (!mates.length) return tl;
  const linkId = E.newId("l");
  const ids = new Set([id, ...mates.map((m) => m.id)]);
  return { ...tl, clips: tl.clips.map((x) => (ids.has(x.id) ? { ...x, linkId } : x)) };
}

function ClipMenu({ x, y, items, onClose }: { x: number; y: number; items: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean }[]; onClose: () => void }) {
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
    <div ref={ref} role="menu" className="fixed z-[300] min-w-[210px] rounded-md border border-edge bg-panel py-1 text-xs shadow-2xl" style={{ left: pos.x, top: pos.y }}>
      {items.map((it, i) => (
        <button
          key={i}
          role="menuitem"
          disabled={it.disabled}
          onClick={() => (it.onClick(), onClose())}
          className={`block w-full px-3 py-1.5 text-left hover:bg-raised disabled:opacity-40 disabled:hover:bg-transparent ${it.danger ? "text-red-400" : "text-gray-200"}`}
        >
          {it.label}
        </button>
      ))}
    </div>,
    document.body
  );
}
