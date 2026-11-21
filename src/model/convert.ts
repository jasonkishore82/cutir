import type { AssetRef, Background, Beat, Layer, LyricLine, Project } from "../store/project";
import type { Clip, Marker, MediaRef, ProjectDoc, Timeline, Track } from "./types";
import { SCHEMA_VERSION } from "./types";

/**
 * The lyric editor works on a "lyric view" (the `Project` type: audio, background, layers, lines, style). The saved
 * document is the general v2 model. These two functions map between them:
 *
 *   docToView(doc)          the active timeline seen as a lyric project
 *   viewToDoc(view, prev)   the document after the lyric view changed; everything the view does not cover
 *                           (other timelines, tracks, clips, media, bins, markers) is kept from `prev`
 *
 * The mapping is lossless for everything the view holds: docToView(viewToDoc(v)) equals v.
 *
 * Fixed ids tie the lyric project's single song and background to their clips and media.
 */

export const IDS = {
  timeline: "tl-main",
  bgTrack: "v-bg",
  audioTrack: "a-song",
  bgClip: "c-bg",
  audioClip: "c-song",
  bgMedia: "m-bg",
  audioMedia: "m-song",
} as const;

/** Output sizes per aspect (kept here so the model does not depend on the renderer). */
const SIZES = { "16:9": [1920, 1080], "9:16": [1080, 1920], "1:1": [1080, 1080] } as const;

/** Seconds stored as start + duration come back as an end time; keep ends like 3.3 exact. */
const tidy = (n: number) => Math.round(n * 1e9) / 1e9;

const LYRIC_FIXED = new Set<string>([IDS.bgTrack, IDS.audioTrack]);

const baseClip = (id: string, trackId: string): Clip => ({
  id,
  trackId,
  start: 0,
  duration: 0,
  fill: true,
  sourceIn: 0,
  sourceOut: 0,
  speed: 1,
  enabled: true,
  effects: [],
  keyframes: {},
});

const track = (id: string, kind: Track["kind"], name: string, prev?: Track): Track =>
  prev ?? { id, kind, name, muted: false, locked: false, solo: false, height: kind === "audio" ? 56 : 44, hidden: false };

function mediaFromAsset(id: string, slot: string, a: AssetRef, prev?: MediaRef): MediaRef {
  const m: MediaRef = { ...(prev ?? {}), id, name: a.name, kind: a.kind, fileKey: slot };
  if (a.mediaId !== undefined) m.poolId = a.mediaId;
  else delete m.poolId;
  if (a.url !== undefined) m.url = a.url;
  else delete m.url;
  return m;
}

function assetFromMedia(m: MediaRef): AssetRef {
  const a: AssetRef = { name: m.name, kind: m.kind === "subtitle" ? "image" : m.kind };
  if (m.url !== undefined) a.url = m.url;
  if (m.poolId !== undefined) a.mediaId = m.poolId;
  return a;
}

/* ---------- view -> document ---------- */

export function viewToDoc(view: Project, prev?: ProjectDoc): ProjectDoc {
  const prevTl = prev?.timelines.find((t) => t.id === (prev.activeTimelineId ?? IDS.timeline));
  const tlId = prevTl?.id ?? IDS.timeline;
  const prevTrack = (id: string) => prevTl?.tracks.find((t) => t.id === id);

  // media: the song and the background come from the view, everything else is kept
  const media: MediaRef[] = (prev?.media ?? []).filter((m) => m.id !== IDS.audioMedia && m.id !== IDS.bgMedia);
  const prevMedia = (id: string) => prev?.media.find((m) => m.id === id);
  if (view.audio) media.push(mediaFromAsset(IDS.audioMedia, "audio", view.audio, prevMedia(IDS.audioMedia)));
  if (view.background.type === "asset" && view.background.asset) media.push(mediaFromAsset(IDS.bgMedia, "bg", view.background.asset, prevMedia(IDS.bgMedia)));

  // tracks: background video track, the lyric layers as subtitle tracks, the song track, then anything else
  const subtitleTracks: Track[] = view.layers.map((l) => {
    const t: Track = { ...track(l.id, "subtitle", l.name, prevTrack(l.id)), kind: "subtitle", name: l.name, hidden: !l.visible, locked: l.locked };
    if (l.style !== undefined) t.style = l.style;
    else delete t.style;
    if (l.lang !== undefined) t.lang = l.lang;
    else delete t.lang;
    return t;
  });
  const layerIds = new Set(view.layers.map((l) => l.id));
  const others = (prevTl?.tracks ?? []).filter((t) => t.kind !== "subtitle" && !LYRIC_FIXED.has(t.id) && !layerIds.has(t.id));
  const tracks: Track[] = [
    track(IDS.bgTrack, "video", "Background", prevTrack(IDS.bgTrack)),
    ...others.filter((t) => t.kind === "video"),
    ...subtitleTracks,
    track(IDS.audioTrack, "audio", "Song", prevTrack(IDS.audioTrack)),
    ...others.filter((t) => t.kind === "audio"),
  ];

  // clips: background and song clips, one subtitle clip per line, then clips on the kept tracks
  const bg: Background = view.background;
  const prevClip = (id: string) => prevTl?.clips.find((c) => c.id === id);
  const bgClip: Clip = { ...baseClip(IDS.bgClip, IDS.bgTrack), ...(prevClip(IDS.bgClip) ?? {}) };
  delete bgClip.mediaId;
  delete bgClip.generator;
  if (bg.type === "gradient") bgClip.generator = { type: "gradient", colors: bg.colors, angle: bg.angle, noise: bg.noise };
  else if (bg.asset) bgClip.mediaId = IDS.bgMedia;

  const clips: Clip[] = [bgClip];
  if (view.audio) clips.push({ ...baseClip(IDS.audioClip, IDS.audioTrack), ...(prevClip(IDS.audioClip) ?? {}), mediaId: IDS.audioMedia });

  for (const l of view.lines) {
    const trackId = l.layerId && layerIds.has(l.layerId) ? l.layerId : view.layers[0].id;
    const duration = l.end - l.start;
    const text: Clip["text"] = { text: l.text };
    if (l.words !== undefined) text.words = l.words;
    if (l.speaker !== undefined) text.speaker = l.speaker;
    if (l.styleOverride !== undefined) text.style = l.styleOverride;
    if (l.transition !== undefined) text.transition = l.transition;
    if (l.wordOverrides !== undefined) text.wordOverrides = l.wordOverrides;
    const kept = prevClip(l.id);
    clips.push({
      id: l.id,
      trackId,
      text,
      start: l.start,
      duration,
      sourceIn: 0,
      sourceOut: duration,
      speed: kept?.speed ?? 1,
      enabled: kept?.enabled ?? true,
      effects: kept?.effects ?? [],
      keyframes: { ...(kept?.keyframes ?? {}), transform: l.keyframes },
    });
    if (!l.keyframes) delete clips[clips.length - 1].keyframes.transform;
  }
  const keptTrackIds = new Set(others.map((t) => t.id));
  clips.push(...(prevTl?.clips ?? []).filter((c) => keptTrackIds.has(c.trackId) || (c.trackId === IDS.bgTrack && c.id !== IDS.bgClip) || (c.trackId === IDS.audioTrack && c.id !== IDS.audioClip)));

  const [width, height] = SIZES[view.aspect];
  // a timeline with a frame shape of its own (a 9:16 version) keeps the project's shape and records its own
  const ownShape = prevTl?.aspect !== undefined;
  const timeline: Timeline = {
    ...(prevTl ?? { id: tlId, name: "Main", markers: [] }),
    id: tlId,
    tracks,
    clips,
    markers: prevTl?.markers ?? [],
    textStyle: view.style,
    transition: view.transition,
    ...(ownShape ? { aspect: view.aspect } : {}),
  };

  return {
    schemaVersion: SCHEMA_VERSION,
    settings: { sampleRate: 48000, ...(prev?.settings ?? {}), colorSpace: view.colourSpace ?? prev?.settings.colorSpace ?? "rec709", outputSpace: view.outputSpace ?? prev?.settings.outputSpace, fps: view.fps, aspect: ownShape ? prev!.settings.aspect : view.aspect, width: ownShape ? prev!.settings.width : width, height: ownShape ? prev!.settings.height : height },
    media,
    bins: prev?.bins ?? [],
    timelines: prev?.timelines.some((t) => t.id === tlId) ? prev.timelines.map((t) => (t.id === tlId ? timeline : t)) : [...(prev?.timelines ?? []), timeline],
    activeTimelineId: tlId,
  };
}

/* ---------- document -> view ---------- */

export const activeTimeline = (doc: ProjectDoc): Timeline => doc.timelines.find((t) => t.id === doc.activeTimelineId) ?? doc.timelines[0];

const beatCache = new WeakMap<Marker[], Beat[]>();
/** The timeline's beats (its beat markers on the ruler), sorted by time. Cached per markers array. */
export function beatsOf(tl: Timeline): Beat[] {
  let b = beatCache.get(tl.markers);
  if (!b) {
    b = tl.markers
      .filter((m) => m.kind === "beat" && !m.clipId)
      .map((m) => ({ time: m.time, downbeat: !!m.downbeat, strength: m.strength ?? 1 }))
      .sort((x, y) => x.time - y.time);
    beatCache.set(tl.markers, b);
  }
  return b;
}

export function docToView(doc: ProjectDoc): Project {
  const tl = activeTimeline(doc);
  const media = (id?: string) => (id ? doc.media.find((m) => m.id === id) : undefined);

  const layers: Layer[] = tl.tracks
    .filter((t) => t.kind === "subtitle")
    .map((t) => {
      const l: Layer = { id: t.id, name: t.name, visible: !t.hidden, locked: t.locked };
      if (t.style !== undefined) l.style = t.style;
      if (t.lang !== undefined) l.lang = t.lang;
      return l;
    });

  const bgClip = tl.clips.find((c) => c.id === IDS.bgClip);
  let background: Background;
  const bgMedia = media(bgClip?.mediaId);
  if (bgClip?.generator?.type === "gradient") background = { type: "gradient", colors: bgClip.generator.colors, angle: bgClip.generator.angle, noise: bgClip.generator.noise };
  else background = bgMedia ? { type: "asset", asset: assetFromMedia(bgMedia) } : { type: "asset" };

  const songMedia = media(tl.clips.find((c) => c.id === IDS.audioClip)?.mediaId);

  const order = new Map(layers.map((l, i) => [l.id, i]));
  const lines: LyricLine[] = tl.clips
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.text && order.has(c.trackId))
    .sort((a, b) => order.get(a.c.trackId)! - order.get(b.c.trackId)! || a.i - b.i)
    .map(({ c }) => {
      const t = c.text!;
      const line: LyricLine = { id: c.id, text: t.text, start: c.start, end: tidy(c.start + c.duration) };
      if (t.words !== undefined) line.words = t.words;
      if (t.speaker !== undefined) line.speaker = t.speaker;
      if (t.style !== undefined) line.styleOverride = t.style;
      line.layerId = c.trackId;
      if (c.keyframes.transform !== undefined) line.keyframes = c.keyframes.transform;
      if (t.transition !== undefined) line.transition = t.transition;
      if (t.wordOverrides !== undefined) line.wordOverrides = t.wordOverrides;
      return line;
    });

  const view: Project = {
    background,
    layers,
    lines,
    style: tl.textStyle,
    aspect: tl.aspect ?? doc.settings.aspect,
    fps: doc.settings.fps,
    transition: tl.transition,
  };
  if (doc.settings.colorSpace && doc.settings.colorSpace !== "rec709") view.colourSpace = doc.settings.colorSpace;
  if (doc.settings.outputSpace) view.outputSpace = doc.settings.outputSpace;
  if (songMedia) view.audio = assetFromMedia(songMedia);
  // derived, read-only: beats from the timeline's beat markers, energy from the song's analysis
  const beats = beatsOf(tl);
  if (beats.length) view.beats = beats;
  const energy = songMedia?.analysis?.energy;
  if (energy) view.energy = energy;
  return view;
}
