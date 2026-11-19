import type { Aspect, Easing, Keyframe, KeyProp, StyleOverride, TextStyle, Transition } from "../store/project";

/**
 * Project model v2: one project holds settings, a media pool, bins and several timelines, each made of tracks and
 * clips. The lyric editor is one use of it: lyric layers are subtitle tracks and lyric lines are subtitle clips
 * with a text payload (see convert.ts).
 */

export const SCHEMA_VERSION = 2;

export type ProjectSettings = {
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
  /** Keyframe lanes by name. Text clips keep their motion keyframes in `transform`. */
  keyframes: { transform?: Keyframe[] } & Record<string, Keyframe[] | undefined>;
};

export type Marker = { id: string; time: number; name: string; color: string };

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
