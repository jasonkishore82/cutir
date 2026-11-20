import type { AudioProcessor } from "../lib/audio/dsp";
import type { Graph } from "../lib/graph/graph";
import type { Tracker } from "../lib/track/tracker";
import type { Aspect, Easing, EnergyCurve, Keyframe, KeyProp, StyleOverride, TextStyle, Transition, WordOverride } from "../store/project";

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
  /** The space the project is graded and composed in (clips are assumed to be in it). */
  colorSpace: "rec709" | "srgb" | "rec2020" | "p3";
  /** The space the preview and export are converted to; the working space when missing. */
  outputSpace?: "rec709" | "srgb" | "rec2020" | "p3";
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
  /** Beat and loudness analysis of an audio (or video with audio) item (phase 16.5). */
  analysis?: AudioAnalysis;
};

/**
 * What beat detection found. The beat times themselves are `kind: "beat"` markers on the timeline that uses the
 * song, so they can be edited and snapped to; this keeps the song-level facts and the loudness curve.
 */
export type AudioAnalysis = {
  /** Beats per minute. */
  tempo: number;
  /** Time of the first downbeat, in source seconds. */
  firstDownbeat: number;
  /** Beats per bar (4 for most songs). */
  beatsPerBar: number;
  /** backend = librosa/madmom, browser = Web Audio, manual = tempo and offset typed by the user. */
  source: "backend" | "browser" | "manual";
  /** RMS loudness, normalised 0..1. */
  energy?: EnergyCurve;
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
  /** Audio tracks (phase 21): the strip in the mixer. Missing values mean gain 1, pan 0, no send, no processors. */
  gain?: number;
  /** -1 (left) to 1 (right). */
  pan?: number;
  /** Send to the shared reverb, 0..1. */
  send?: number;
  /** Tracks with the same group name move their gain together. */
  group?: string;
  processors?: AudioProcessor[];
  /** Automation lanes of the strip (time in timeline seconds). */
  anim?: Partial<Record<"gain" | "pan", ParamKey[]>>;
};

/** The master strip of a timeline's mix (phase 21). */
export type MasterStrip = { gainDb: number; processors?: AudioProcessor[]; /** Peak ceiling in dB, held by a limiter after the gain. */ ceiling?: number };

/** A clip's content when it is not a media file. */
export type Generator =
  | { type: "gradient"; colors: string[]; angle: number; noise: boolean }
  | { type: "solid"; color: string }
  | { type: "shape"; shape: ShapeSpec }
  | { type: "noise"; amount: number; scale: number; mono: boolean; speed: number; color: string }
  | { type: "countdown"; from: number; color: string; ring: boolean; size: number; font: string }
  | { type: "timecode"; color: string; size: number; font: string; fps: number; offset: number; box: boolean }
  | { type: "title"; title: TitleSpec };

/** A drawn shape (phase 19). Sizes are fractions of the frame height, positions fractions of the frame. */
export type ShapeSpec = {
  kind: "rectangle" | "ellipse" | "line" | "polygon" | "arrow";
  x: number;
  y: number;
  width: number;
  height: number;
  /** Fill colour, or "" for none. */
  fill: string;
  stroke: string;
  strokeWidth: number;
  /** Rectangle corner radius as a fraction of the shorter side. */
  radius: number;
  /** Polygon corner count (3 to 12). */
  sides: number;
  /** Degrees. */
  rotation: number;
};

/** A character range with its own look; `start` is inclusive and `end` exclusive, counted in letters of the text. */
export type TextRun = { start: number; end: number; color?: string; weight?: number; italic?: boolean; underline?: boolean; size?: number; font?: string };

/**
 * What a unit looks like before it arrives (custom animator). It eases to rest as the sweep reaches it.
 * Offsets are in text heights, rotation in degrees, `tint` is how much of the second colour is mixed in (0..1).
 */
export type AnimatorFrom = { opacity: number; dx: number; dy: number; scale: number; rotation: number; blur: number; tint: number };

export type TitleAnimator = {
  preset: "none" | "typewriter" | "word-pop" | "line-slide" | "wave" | "blur-in" | "karaoke-fill" | "roll" | "spin-in" | "slide-in" | "drop-in" | "colour-flash" | "custom";
  /** Starting look for the `custom` preset. */
  from?: AnimatorFrom;
  /** Animate by letter, word or line. */
  unit: "char" | "word" | "line";
  /** Seconds the whole animation takes to sweep across the text (in), and how long each unit takes. */
  duration: number;
  /** Range selector: where the sweep starts and ends along the text (0..100) and the shift of both. */
  rangeStart: number;
  rangeEnd: number;
  offset: number;
  /** Fade the title out over the last seconds. */
  outDuration: number;
};

/** A title: a text box with its look (phase 19). Sizes are fractions of the frame height. */
export type TitleSpec = {
  text: string;
  font: string;
  weight: number;
  italic: boolean;
  underline: boolean;
  size: number;
  color: string;
  /** Second colour: with `gradient` the fill runs from `color` to it. */
  color2: string;
  gradient: boolean;
  gradientAngle: number;
  /** An image (data URL) used as the fill instead of colour. */
  fillImage?: string;
  align: "left" | "center" | "right";
  lineHeight: number;
  letterSpacing: number;
  /** Box centre and width, fractions of the frame. */
  x: number;
  y: number;
  width: number;
  /** Shrink the text to fit the box when it is too tall or wide. */
  autoFit: boolean;
  stroke: string;
  strokeWidth: number;
  shadow: boolean;
  shadowColor: string;
  shadowBlur: number;
  glow: number;
  glowColor: string;
  /** Layered strokes that fake a bevel. */
  bevel: boolean;
  box: { color: string; padding: number; radius: number; opacity: number } | null;
  runs: TextRun[];
  animator: TitleAnimator;
  /** Credits roll: pixels (fraction of height) per second the block moves up; 0 = no roll. */
  roll: number;
  /** Fonts tried in order when the first is missing. */
  fallback: string[];
};

/** Subtitle clips carry their text and its look. */
export type TextPayload = {
  text: string;
  words?: { text: string; start: number; end: number }[];
  style?: StyleOverride;
  /** Hand-over into the next clip on the same track. */
  transition?: Transition;
  /** Per-word overrides keyed by word index (phase 16.5). */
  wordOverrides?: Record<number, WordOverride>;
};

/**
 * A keyframe of one animated value; `t` is seconds from the clip's start. See src/lib/keyframes/engine.ts for the
 * value kinds (number, colour, point, angle) and shapes (hold, linear, ease, bezier). Older projects have
 * `{ t, v, easing }` only, which still reads the same way.
 */
export type ParamKey = {
  t: number;
  v: number | string | { x: number; y: number };
  mode?: "hold" | "linear" | "ease" | "bezier";
  easing?: Easing | "bounce";
  out?: [number, number];
  in?: [number, number];
};

/** One effect in a clip's stack (phase 17). `type` names an effect in src/lib/effects; params follow its spec. */
export type ClipEffect = {
  id: string;
  type: string;
  enabled: boolean;
  params: Record<string, unknown>;
  /** Keyframes per numeric param (the param's own value is used where there are none). */
  keys?: Record<string, ParamKey[]>;
};

/**
 * A transition at a cut between two clips on a track (`from` -> `to`), or at one clip's edge (only `from`: out to
 * nothing; only `to`: in from nothing). Works on video tracks (pictures) and audio tracks (a crossfade).
 */
export type ClipTransition = {
  id: string;
  trackId: string;
  from?: string;
  to?: string;
  /** A transition id from src/lib/effects (audio tracks use "crossfade"). */
  type: string;
  /** Seconds. */
  duration: number;
  /** Where the transition sits relative to the cut: ending at it, centred on it, or starting at it. */
  align: "start" | "center" | "end";
  easing: Easing;
  params: Record<string, unknown>;
};

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
  /** Audio clip fades in seconds (equal power) and reverse playback (phase 21). */
  fadeIn?: number;
  fadeOut?: number;
  reverse?: boolean;
  /** Compositing (phase 22). */
  matte?: TrackMatte;
  /** Points followed through this clip's picture, by the tracker. */
  trackers?: Tracker[];
  /** Pin this clip's position to a tracker of another clip (a title on a moving object). */
  follow?: { clipId: string; trackerId: string };
  /** Steady this clip's picture from one of its own trackers. */
  stabilize?: { trackerId: string; smoothing: number; zoom: number };
  /** The clip's node graph; when present it replaces the effect stack (a plain chain converts back to a stack). */
  graph?: Graph;
  /** Keyframe lanes by name. Text clips keep their motion keyframes in `transform`. */
  keyframes: { transform?: Keyframe[] } & Record<string, Keyframe[] | undefined>;
  /**
   * Animated placement and volume (phase 18): lanes by value name ("x", "y", "scale", "rotation", "opacity",
   * "volume"). A lane with keys overrides the plain value in `transform` / `volume` over time.
   */
  anim?: Partial<Record<"x" | "y" | "scale" | "rotation" | "opacity" | "volume", ParamKey[]>>;
};

export type BlendMode = "normal" | "multiply" | "screen" | "overlay" | "softlight" | "hardlight" | "darken" | "lighten" | "add" | "difference" | "exclusion" | "dodge" | "burn";

/** Use another clip as the matte of this one (phase 22): its alpha or its brightness decides what shows. */
export type TrackMatte = { clipId: string; mode: "alpha" | "luma" | "alpha-inverted" | "luma-inverted" };

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

export type Marker = {
  id: string;
  time: number;
  name: string;
  color: string;
  note?: string;
  /** On a clip instead of the ruler. */
  clipId?: string;
  /** "beat" markers come from beat detection (phase 16.5). Missing = "user". */
  kind?: "user" | "beat";
  /** Beat markers: first beat of a bar. */
  downbeat?: boolean;
  /** Beat markers: onset strength 0..1. */
  strength?: number;
  /** Beat markers: the media item whose analysis made this marker (re-detection replaces only these). */
  sourceMediaId?: string;
};

export const isBeat = (m: Marker) => m.kind === "beat";

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
  /** Transitions at cuts and clip edges on video and audio tracks (phase 17). */
  cutTransitions?: ClipTransition[];
  /** The master of the audio mix (phase 21). */
  master?: MasterStrip;
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
