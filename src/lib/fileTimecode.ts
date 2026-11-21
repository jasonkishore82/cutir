/**
 * Start timecode read straight from a file (phase 24), without decoding it: the timecode track of an MP4 or MOV
 * (camera files) and the time reference of a Broadcast WAV (field recorders). Both give seconds since midnight.
 * `read(offset, length)` returns that slice of the file; nothing else is touched, so a large file costs a few small reads.
 */
export type Reader = (offset: number, length: number) => Promise<Uint8Array>;

const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u32le = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const tag = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

type Box = { type: string; start: number; body: number; end: number };

/** The child boxes found in [from, to) of a file. */
async function boxes(read: Reader, from: number, to: number): Promise<Box[]> {
  const out: Box[] = [];
  let p = from;
  while (p + 8 <= to && out.length < 200) {
    const h = await read(p, 16);
    if (h.length < 8) break;
    let size = u32(h, 0);
    let head = 8;
    if (size === 1 && h.length >= 16) (size = u32(h, 8) * 4294967296 + u32(h, 12)), (head = 16);
    else if (size === 0) size = to - p;
    if (size < head) break;
    out.push({ type: tag(h, 4), start: p, body: p + head, end: Math.min(to, p + size) });
    p += size;
  }
  return out;
}

/** Seconds since midnight from the `tmcd` track of an MP4 or MOV, or null. */
export async function readMovTimecode(read: Reader, size: number): Promise<number | null> {
  const moov = (await boxes(read, 0, size)).find((b) => b.type === "moov");
  if (!moov) return null;
  for (const trak of (await boxes(read, moov.body, moov.end)).filter((b) => b.type === "trak")) {
    const find = async (parent: Box, path: string[]): Promise<Box | undefined> => {
      let cur: Box | undefined = parent;
      for (const t of path) {
        if (!cur) return undefined;
        cur = (await boxes(read, cur.body, cur.end)).find((b) => b.type === t);
      }
      return cur;
    };
    const stbl = await find(trak, ["mdia", "minf", "stbl"]);
    if (!stbl) continue;
    const kids = await boxes(read, stbl.body, stbl.end);
    const stsd = kids.find((b) => b.type === "stsd");
    if (!stsd) continue;
    // stsd: version/flags (4), entry count (4), then the entry: size (4), type (4), reserved (6), data ref (2),
    // reserved (4), flags (4), time scale (4), frame duration (4), frames per second (1)
    const d = await read(stsd.body, Math.min(stsd.end - stsd.body, 64));
    if (d.length < 41 || tag(d, 12) !== "tmcd") continue;
    const timescale = u32(d, 32);
    const frameDuration = u32(d, 36);
    if (!timescale || !frameDuration) continue;
    // the first sample is one 32-bit frame counter, at the first chunk offset
    const co = kids.find((b) => b.type === "stco" || b.type === "co64");
    if (!co) continue;
    const c = await read(co.body, 16);
    if (c.length < 12 || u32(c, 4) < 1) continue;
    const off = co.type === "stco" ? u32(c, 8) : u32(c, 8) * 4294967296 + u32(c, 12);
    const s = await read(off, 4);
    if (s.length < 4) continue;
    const frames = u32(s, 0);
    const sec = (frames * frameDuration) / timescale;
    if (sec >= 0 && sec < 86400 * 2) return Math.round(sec * 1000) / 1000;
  }
  return null;
}

/** Seconds since midnight from the `bext` time reference of a Broadcast WAV, or null. */
export async function readWavTimecode(read: Reader, size: number): Promise<number | null> {
  const head = await read(0, 12);
  if (head.length < 12 || tag(head, 0) !== "RIFF" || tag(head, 8) !== "WAVE") return null;
  let p = 12;
  let rate = 0;
  let ref: number | null = null;
  for (let n = 0; n < 40 && p + 8 <= size; n++) {
    const h = await read(p, 8);
    const id = tag(h, 0);
    const len = u32le(h, 4);
    if (id === "fmt ") rate = u32le(await read(p + 8, 8), 4);
    if (id === "bext" && len >= 346) {
      const b = await read(p + 8 + 338, 8);
      ref = u32le(b, 4) * 4294967296 + u32le(b, 0);
    }
    if (id === "data" && ref !== null) break; // the chunks after the sound are not needed
    p += 8 + len + (len & 1);
  }
  return ref !== null && rate > 0 ? Math.round((ref / rate) * 1000) / 1000 : null;
}

export async function readFileTimecode(read: Reader, size: number): Promise<number | null> {
  try {
    const head = await read(0, 12);
    if (head.length >= 12 && tag(head, 0) === "RIFF") return await readWavTimecode(read, size);
    return await readMovTimecode(read, size);
  } catch {
    return null;
  }
}

export const readerOf = (file: Blob): Reader => async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
