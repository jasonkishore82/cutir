import { ALL_FORMATS, BlobSource, CanvasSink, Input, type WrappedCanvas } from "mediabunny";

/**
 * Decoded pictures for the compositor.
 *
 * Video is decoded with WebCodecs through mediabunny (the decoder itself runs off the main thread). Each media file
 * gets one VideoStream that serves three ways:
 *   - playback: a forward iterator decodes a few frames ahead; late frames are skipped and counted as dropped
 *   - scrubbing: the newest request wins; meanwhile the nearest frame already decoded is shown
 *   - export:   `exact(t)` walks the file in order and returns precisely the frame at t
 * Decoded frames are kept in one LRU cache with a memory budget, so going back to a recent spot is instant.
 * Images are decoded once into ImageBitmaps.
 */

export type Picture = CanvasImageSource & { width: number; height: number };

const LOOKAHEAD = 6;
const MAX_DECODE_WIDTH = 1920;

/* ---------- the frame cache ---------- */

type Cached = { stream: VideoStream; frame: WrappedCanvas; bytes: number };
const cache = new Map<string, Cached>(); // insertion order = age (oldest first)
let cacheBytes = 0;
/** Memory budget for decoded frames. Smaller on devices that report little memory. */
let budget = (((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8) >= 8 ? 768 : 256) * 1024 * 1024;

export const stats = { decoded: 0, dropped: 0, cacheHits: 0, get cacheMB() { return Math.round(cacheBytes / 1048576); }, get cacheFrames() { return cache.size; } };

function remember(stream: VideoStream, f: WrappedCanvas) {
  const key = `${stream.id}@${f.timestamp.toFixed(4)}`;
  if (cache.has(key)) {
    const c = cache.get(key)!;
    cache.delete(key);
    cache.set(key, c); // refresh age
    return;
  }
  const bytes = f.canvas.width * f.canvas.height * 4;
  cache.set(key, { stream, frame: f, bytes });
  cacheBytes += bytes;
  trim(budget);
}

function trim(limit: number) {
  for (const [k, c] of cache) {
    if (cacheBytes <= limit) break;
    cache.delete(k);
    cacheBytes -= c.bytes;
  }
}

/** Cached frame of a stream nearest to t (preferring the one showing at t). */
function nearestCached(stream: VideoStream, t: number): WrappedCanvas | null {
  let best: WrappedCanvas | null = null;
  for (const c of cache.values()) {
    if (c.stream !== stream) continue;
    const f = c.frame;
    if (f.timestamp <= t + 1e-6 && t < f.timestamp + f.duration) return f;
    if (!best || Math.abs(f.timestamp - t) < Math.abs(best.timestamp - t)) best = f;
  }
  return best;
}

/** Free memory: when the tab is hidden, or when asked to (e.g. after closing a project). */
export function releaseFrames(keepRatio = 0) {
  trim(budget * keepRatio);
}
if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => document.hidden && releaseFrames(0.25));

/* ---------- video ---------- */

export class VideoStream {
  readonly id: string;
  private input: Input | null = null;
  private sink: CanvasSink | null = null;
  private ready: Promise<boolean>;
  private ok = false;
  state: "loading" | "ready" | "failed" = "loading";
  error = "";
  // playback
  private queue: WrappedCanvas[] = [];
  private gen = 0;
  private pumping = false;
  /** Where a new playback iterator starts: the playhead after a jump, else just after the last queued frame. */
  private cursor = 0;
  private shown: WrappedCanvas | null = null;
  // scrubbing
  private want: number | null = null;
  private seeking = false;
  // export
  private x: AsyncGenerator<WrappedCanvas> | null = null;
  private xCur: WrappedCanvas | null = null;
  private xNext: WrappedCanvas | null = null;

  constructor(id: string, file: Blob, maxWidth = MAX_DECODE_WIDTH) {
    this.id = id;
    this.ready = (async () => {
      try {
        this.input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
        const track = await this.input.getPrimaryVideoTrack();
        if (!track || !(await track.canDecode())) throw new Error(track ? `cannot decode ${track.codec ?? "this video"}` : "no video track");
        const width = Math.min(maxWidth, track.displayWidth);
        this.sink = new CanvasSink(track, { width });
        this.ok = true;
        this.state = "ready";
        return true;
      } catch (e) {
        this.state = "failed";
        this.error = (e as Error).message;
        return false;
      }
    })();
  }

  /** The picture to show at source time t right now (never waits). Starts decoding what is missing. */
  frameFor(t: number, playing: boolean): Picture | null {
    if (!this.ok) return null;
    if (playing) {
      // a jump (seek, loop, first play): restart decoding at t
      const lo = this.queue.length ? this.queue[0].timestamp : this.shown ? this.shown.timestamp : -Infinity;
      if (t < lo - 0.25 || t > this.cursor + 1) this.restart(t);
      // take every frame that is due; frames passed over without being shown were dropped
      let picked: WrappedCanvas | null = null;
      while (this.queue.length && this.queue[0].timestamp <= t + 1e-6) {
        if (picked && picked !== this.shown) stats.dropped++;
        picked = this.queue.shift()!;
      }
      if (picked) {
        this.shown = picked;
        remember(this, picked);
      }
      this.pump();
      if (this.shown && this.shown.timestamp <= t + 0.5 && t < this.shown.timestamp + this.shown.duration + 0.5) return this.shown.canvas as Picture;
      const near = nearestCached(this, t);
      return near ? (near.canvas as Picture) : null;
    }
    // paused / scrubbing: exact frame when cached, else show the nearest one and ask for the right one
    this.stopPlayback();
    const near = nearestCached(this, t);
    if (near && near.timestamp <= t + 1e-6 && t < near.timestamp + near.duration) {
      stats.cacheHits++;
      return near.canvas as Picture;
    }
    this.request(t);
    return near ? (near.canvas as Picture) : this.shown ? (this.shown.canvas as Picture) : null;
  }

  /** Exactly the frame at t, for export (walks forward through the file; jumps restart it). */
  async exact(t: number): Promise<Picture | null> {
    if (!(await this.ready)) return null;
    const eps = 1e-6;
    if (!this.x || (this.xCur && t < this.xCur.timestamp - eps) || (this.xCur && t > this.xCur.timestamp + 3)) {
      await this.x?.return(undefined);
      this.x = this.sink!.canvases(Math.max(0, t));
      this.xCur = null;
      this.xNext = null;
    }
    for (;;) {
      if (!this.xNext) {
        const r = await this.x.next();
        if (r.done) break;
        this.xNext = r.value;
        stats.decoded++;
      }
      if (this.xNext.timestamp <= t + eps) {
        this.xCur = this.xNext;
        this.xNext = null;
      } else break;
    }
    if (this.xCur) return this.xCur.canvas as Picture;
    const f = await this.sink!.getCanvas(t); // t falls before the first frame the iterator gave
    return f ? (f.canvas as Picture) : null;
  }

  private restart(t: number) {
    this.gen++;
    this.queue = [];
    this.cursor = t;
    this.pumping = false;
  }

  private pump() {
    if (this.pumping || this.queue.length >= LOOKAHEAD) return;
    this.pumping = true;
    const gen = this.gen;
    const from = this.cursor;
    void (async () => {
      const it = this.sink!.canvases(Math.max(0, from));
      try {
        while (gen === this.gen) {
          if (this.queue.length >= LOOKAHEAD) {
            await new Promise((r) => setTimeout(r, 8));
            continue;
          }
          const r = await it.next();
          if (r.done || gen !== this.gen) break;
          stats.decoded++;
          this.queue.push(r.value);
          this.cursor = r.value.timestamp + r.value.duration;
        }
      } catch {
        /* decoder error: the next frameFor restarts */
      } finally {
        await it.return(undefined);
        if (gen === this.gen) this.pumping = false;
      }
    })();
  }

  private stopPlayback() {
    if (this.pumping || this.queue.length) {
      this.gen++;
      this.queue = [];
      this.pumping = false;
    }
  }

  private request(t: number) {
    this.want = t;
    if (this.seeking) return;
    this.seeking = true;
    void (async () => {
      try {
        while (this.want !== null) {
          const target = this.want;
          this.want = null;
          const f = await this.sink!.getCanvas(Math.max(0, target));
          if (f) {
            stats.decoded++;
            remember(this, f);
            this.shown = f;
          }
        }
      } catch {
        /* keep showing what we have */
      } finally {
        this.seeking = false;
      }
    })();
  }

  close() {
    this.gen++;
    void this.x?.return(undefined);
    this.input?.dispose();
    for (const [k, c] of cache) if (c.stream === this) (cache.delete(k), (cacheBytes -= c.bytes));
  }
}

/* ---------- the registry of open sources ---------- */

type Entry = { video?: VideoStream; image?: ImageBitmap; loading?: Promise<void>; failed?: string };
const open = new Map<string, Entry>();

/** Playback may decode a proxy or optimized copy; export decodes the original (phase 16). */
export type Purpose = "playback" | "export";

/** How sources find their files (set by the app: media pool lookups, choosing proxies for playback). */
let resolveFile: (mediaId: string, purpose: Purpose) => Promise<Blob | null> = async () => null;
export const setFileResolver = (fn: typeof resolveFile) => (resolveFile = fn);

function entry(mediaId: string, kind: "video" | "image", purpose: Purpose = "playback"): Entry {
  const key = `${mediaId}|${kind === "image" ? "playback" : purpose}`; // images are the same file either way
  let e = open.get(key);
  if (e) return e;
  e = {};
  open.set(key, e);
  const en = e;
  en.loading = (async () => {
    const file = await resolveFile(mediaId, kind === "image" ? "playback" : purpose);
    if (!file) {
      en.failed = "file not available";
      return;
    }
    if (kind === "video") en.video = new VideoStream(mediaId, file);
    else {
      try {
        en.image = await createImageBitmap(file);
      } catch {
        en.failed = "cannot read the image";
      }
    }
  })();
  return e;
}

/** Close sources no longer on the timeline (frees decoders and cached frames). */
export function closeUnused(keep: Set<string>) {
  for (const [key, e] of open) {
    if (keep.has(key.split("|")[0])) continue;
    e.video?.close();
    e.image?.close();
    open.delete(key);
  }
}

/** Reopen the playback decoders (after a proxy appears or goes, or the proxy setting changes). */
export function reopenPlayback() {
  for (const [key, e] of open) {
    if (!key.endsWith("|playback") || !e.video) continue;
    e.video.close();
    open.delete(key);
  }
}

export function closeAll() {
  closeUnused(new Set());
  cache.clear();
  cacheBytes = 0;
}

/** Decoder state for the diagnostics panel. */
export function sourceStates(): { id: string; state: string }[] {
  return [...open].map(([id, e]) => ({ id: id.replace("|", " "), state: e.failed ? `failed: ${e.failed}` : e.video ? (e.video.state === "failed" ? `failed: ${e.video.error}` : e.video.state) : e.image ? "image" : "loading" }));
}

/* ---------- providers: what the compositor asks for pictures ---------- */

export type FrameProvider = {
  /** The picture of a clip's media at a source time; null while it is not decoded yet. */
  picture: (mediaId: string, kind: "video" | "image", sourceTime: number) => Picture | null;
};

/** For the viewer: never waits; decodes ahead while playing. */
export function liveFrames(playing: boolean): FrameProvider {
  return {
    picture: (mediaId, kind, st) => {
      const e = entry(mediaId, kind);
      if (kind === "image") return (e.image as Picture | undefined) ?? null;
      return e.video ? e.video.frameFor(st, playing) : null;
    },
  };
}

/**
 * Exact pictures: `prepare` waits until every picture needed at t is decoded, then `picture` returns them.
 * Export uses the originals; render_frame and export-from-proxies may ask for the playback files.
 */
export function exactFrames(purpose: Purpose = "export") {
  const ready = new Map<string, Picture | null>();
  const key = (id: string, st: number) => `${id}@${st.toFixed(5)}`;
  return {
    async prepare(needs: { mediaId: string; kind: "video" | "image"; sourceTime: number }[]) {
      ready.clear();
      for (const n of needs) {
        const e = entry(n.mediaId, n.kind, purpose);
        await e.loading;
        if (n.kind === "image") ready.set(key(n.mediaId, n.sourceTime), (e.image as Picture | undefined) ?? null);
        else ready.set(key(n.mediaId, n.sourceTime), e.video ? await e.video.exact(n.sourceTime) : null);
      }
    },
    picture: (mediaId: string, _kind: "video" | "image", st: number) => ready.get(key(mediaId, st)) ?? null,
  };
}
