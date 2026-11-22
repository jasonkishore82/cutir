/**
 * Zip files built and read without loading media into memory (phase 29). Entries are Blobs: writing streams each one once
 * to get its CRC and then puts the same Blob in the result (a Blob can point at a file on disk), reading slices the archive.
 * No zip64: archives and entries must stay under 4 GB, which is checked and reported.
 */

let table: Uint32Array | undefined;
const crcTable = () => {
  if (table) return table;
  table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
};

export const crcUpdate = (crc: number, data: Uint8Array): number => {
  const t = crcTable();
  let c = crc;
  for (let i = 0; i < data.length; i++) c = t[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return c;
};

/** CRC-32 of a blob, read in chunks. */
export async function crcOfBlob(blob: Blob): Promise<number> {
  const reader = blob.stream().getReader();
  let crc = 0xffffffff;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    crc = crcUpdate(crc, value);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export type PackEntry = { name: string; blob: Blob };
const LIMIT = 0xfffffffe;

export async function writeZip(entries: PackEntry[], onProgress?: (done: number, total: number) => void): Promise<Blob> {
  const enc = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  let n = 0;
  for (const e of entries) {
    if (e.blob.size > LIMIT) throw new Error(`"${e.name}" is larger than 4 GB, which the package format cannot hold. Keep that file out of the package.`);
    const name = enc.encode(e.name);
    const crc = await crcOfBlob(e.blob);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 0x0800, true);
    head.setUint16(10, 0, true);
    head.setUint16(12, 0x21, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, e.blob.size, true);
    head.setUint32(22, e.blob.size, true);
    head.setUint16(26, name.length, true);
    const at = offset;
    parts.push(new Uint8Array(head.buffer), name, e.blob);
    offset += 30 + name.length + e.blob.size;
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(14, 0x21, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, e.blob.size, true);
    c.setUint32(24, e.blob.size, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, at, true);
    central.push(new Uint8Array(c.buffer), name);
    onProgress?.(++n, entries.length);
  }
  const start = offset;
  let size = 0;
  for (const c of central) {
    parts.push(c);
    size += c.length;
  }
  if (start + size > LIMIT) throw new Error("The package would be larger than 4 GB, which the format cannot hold.");
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, start, true);
  parts.push(new Uint8Array(end.buffer));
  return new Blob(parts, { type: "application/zip" });
}

export type ZipItem = { name: string; size: number; crc: number; method: number; read: () => Promise<Blob> };

async function inflate(raw: Blob): Promise<Blob> {
  if (typeof DecompressionStream === "undefined") throw new Error("This browser cannot unpack compressed zip files.");
  const stream = raw.stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Response(stream).blob();
}

/** The entries of a zip (stored or deflated). Throws a readable message for anything else. */
export async function readZip(zip: Blob): Promise<ZipItem[]> {
  const tailLen = Math.min(zip.size, 65557);
  const tail = new DataView(await zip.slice(zip.size - tailLen).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("This is not a zip file, or it is cut short.");
  const count = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdStart = tail.getUint32(eocd + 16, true);
  if (count === 0xffff || cdStart === 0xffffffff) throw new Error("This zip uses zip64 (over 4 GB), which is not supported.");
  const cd = new DataView(await zip.slice(cdStart, cdStart + cdSize).arrayBuffer());
  const dec = new TextDecoder();
  const out: ZipItem[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.byteLength || cd.getUint32(p, true) !== 0x02014b50) throw new Error("The zip file is damaged (bad directory).");
    const method = cd.getUint16(p + 10, true);
    const crc = cd.getUint32(p + 16, true);
    const csize = cd.getUint32(p + 20, true);
    const size = cd.getUint32(p + 24, true);
    const nl = cd.getUint16(p + 28, true), el = cd.getUint16(p + 30, true), cl = cd.getUint16(p + 32, true);
    const at = cd.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nl));
    p += 46 + nl + el + cl;
    out.push({
      name,
      size,
      crc,
      method,
      read: async () => {
        const lh = new DataView(await zip.slice(at, at + 30).arrayBuffer());
        if (lh.getUint32(0, true) !== 0x04034b50) throw new Error(`"${name}" is damaged (bad header).`);
        const from = at + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
        const raw = zip.slice(from, from + csize);
        if (method === 0) return raw;
        if (method === 8) return inflate(raw);
        throw new Error(`"${name}" uses a compression method (${method}) this reader does not support.`);
      },
    });
  }
  return out;
}

/** True when the entry's bytes match the CRC stored in the archive. */
export async function entryIsIntact(item: ZipItem): Promise<boolean> {
  try {
    return (await crcOfBlob(await item.read())) === item.crc;
  } catch {
    return false;
  }
}
