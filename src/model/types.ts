import type { Aspect, Easing, Keyframe, KeyProp, StyleOverride, TextStyle, Transition } from "../store/project";

/**
 * Project model v2: one project holds settings, a media pool, bins and several timelines, each made of tracks and
 * clips. The lyric editor is one use of it: lyric layers are subtitle tracks and lyric lines are subtitle clips
 * with a text payload (see convert.ts).
 */

export const SCHEMA_VERSION = 2;

/** Smaller copies of large videos used for smooth playback (phase 16). */
export type ProxySettings = {
  /** Play proxies (and optimized copies) instead of the originals when they exist. */
  use: boolean;
  /** Proxy size: a fraction of the original height or a fixed height. */
  size: "half" | "quarter" | "540" | "720" | "1080";
  /** Suggest proxies for clips larger than 1080p or when playback drops frames. */
  suggest: boolean;
  /** Export from proxies instead of the originals (off unless the user chooses it). */
  exportFromProxies: boolean;
};

/** Finished frames kept for smooth playback of heavy parts (phase 16). */
export type RenderCacheSettings = {
  /** off; smart = only frames that did not play in real time; always = every frame with video or images. */
  mode: "off" | "smart" | "always";
  sizeMB: number;
};

export const DEFAULT_PROXY: ProxySettings = { use: true, size: "half", suggest: true, exportFromProxies: false };
export const DEFAULT_CACHE: RenderCacheSettings = { mode: "smart", sizeMB: 512 };

export type ProjectSettings = {
  proxy?: ProxySettings;
  renderCache?: RenderCacheSettings;
  aspect: Aspect;
  /** Output size in pixels (follows the aspect today). */
  width: number;
  height: number;
  fps: 30 | 60;
  colorSpace: "rec709";
  sampleRate: 44100 | 48000;
};

export type MediaKind = "video" | "audio" | "image" | "subtitle";

export type MediaRef = {
  id: string;
  name: string;
  kind: MediaKind;
  /** Where the file is stored, relative to the project (IndexedDB key `<projectId>/<fileKey>`). */
  fileKey: string;
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio?: boolean;
  /** Why it cannot be played here (unsupported codec...). */
  note?: string;
  /** The media-pool item this came from. */
  poolId?: string;
  /** Object URL for this session only; never saved. */
  url?: string;
};

export type Bin = { id: string; name: string; parentId?: string; mediaIds: string[] };

export type TrackKind = "video" | "audio" | "subtitle";

export type Track = {
  id: string;
  kind: TrackKind;
  name: string;
  muted: boolean;
  locked: boolean;
  solo: boolean;
  /** Height in the timeline, in pixels. */
  height: number;
  /** Hidden tracks are not drawn (video, subtitle) or heard (audio). */
  hidden: boolean;
  /** Subtitle tracks: style overrides for every clip on the track (the old layer style). */
  style?: StyleOverride;
  /** Receives inserts and overwrites from the media pool (one video and one audio track at a time). */
  target?: boolean;
};

/** A clip's content when it is not a media file. */
export type Generator = { type: "gradient"; colors: string[]; angle: number; noise: boolean };

/** Subtitle clips carry their text and its look. */
export type TextPayload = {
  text: string;
  words?: { text: string; start: number; end: number }[];
  style?: StyleOverride;
  /** Hand-over into the next clip on the same track. */
  transition?: Transition;
};

export type ClipEffect = { id: string; type: string; enabled: boolean; params: Record<string, unknown> };

export type Clip = {
  id: string;
  trackId: string;
  /** Shown on the clip block; defaults to the media name. */
  name?: string;
  /** Clips with the same linkId (a video and its sound) are selected, moved and trimmed together. */
  linkId?: string;
  /** Media from the pool, for video, audio and image clips. */
  mediaId?: string;
  generator?: Generator;
  text?: TextPayload;
  /** Timeline position in seconds. */
  start: number;
  duration: number;
  /** Covers the whole timeline whatever its length (the song and the background of a lyric video). */
  fill?: boolean;
  /** Part of the source used, in source seconds. */
  sourceIn: number;
  sourceOut: number;
  speed: number;
  enabled: boolean;
  effects: ClipEffect[];
  /** Placement of a video or image clip in the frame (phase 15). */
  transform?: Partial<ClipTransform>;
  /** Clip volume for audio, 0..2 (1 = as recorded). */
  volume?: number;
  /** Keyframe lanes by name. Text clips keep their motion keyframes in `transform`. */
  keyframes: { transform?: Keyframe[] } & Record<string, Keyframe[] | undefined>;
};

export type BlendMode = "normal" | "multiply" | "screen" | "overlay" | "darken" | "lighten" | "add" | "difference";

/** How a video or image clip sits in the frame. Missing = centred, fitted inside the frame, fully opaque. */
export type ClipTransform = {
  /** Centre as 0..1 of the frame width / height. */
  x: number;
  y: number;
  scale: number;
  /** Degrees clockwise. */
  rotation: number;
  opacity: number;
  blend: BlendMode;
  /** How the source fills the frame before scaling. */
  fit: "contain" | "cover" | "fill";
};

export const IDENTITY_TRANSFORM: ClipTransform = { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1, blend: "normal", fit: "contain" };

export type Marker = { id: string; time: number; name: string; color: string; note?: string; /** On a clip instead of the ruler. */ clipId?: string };

export type Timeline = {
  id: string;
  name: string;
  /** Drawn bottom to top in array order within each kind. */
  tracks: Track[];
  clips: Clip[];
  markers: Marker[];
  inPoint?: number;
  outPoint?: number;
  /** Base look of every text clip on this timeline (tracks and clips override it). */
  textStyle: TextStyle;
  /** Default hand-over between consecutive text clips. */
  transition: Transition;
};

export type ProjectDoc = {
  schemaVersion: typeof SCHEMA_VERSION;
  settings: ProjectSettings;
  media: MediaRef[];
  bins: Bin[];
  timelines: Timeline[];
  activeTimelineId: string;
};

export type { Easing, KeyProp };
