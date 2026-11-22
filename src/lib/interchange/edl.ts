import { fromEditList, round, type EditItem, type EditList, type EditTrack, type Note } from "./common";

/** CMX 3600 edit decision lists: one event per clip, video on V, audio on A, A2 ... Timecode is non drop frame. */

export const toTc = (sec: number, fps: number): string => {
  const f = Math.round(sec * fps);
  const base = Math.round(fps);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(f / (base * 3600)))}:${p(Math.floor(f / (base * 60)) % 60)}:${p(Math.floor(f / base) % 60)}:${p(f % base)}`;
};

export const fromTc = (tc: string, fps: number): number | null => {
  const m = /^(\d+):(\d\d):(\d\d)[:;](\d\d)$/.exec(tc.trim());
  if (!m) return null;
  const base = Math.round(fps);
  return (Number(m[1]) * 3600 * base + Number(m[2]) * 60 * base + Number(m[3]) * base + Number(m[4])) / fps;
};

const reelOf = (name: string, n: number) => {
  const r = name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 8);
  return r || `AX${n}`;
};

/**
 * One list for the whole timeline. EDL has a single video channel, so only the lowest video track is written and
 * the others are reported; every audio track is written as its own channel (A, A2, A3 ...).
 */
export function exportEdl(list: EditList): { text: string; report: Note[] } {
  const report: Note[] = [];
  const fps = list.fps;
  const lines = [`TITLE: ${list.name}`, "FCM: NON-DROP FRAME", ""];
  let n = 1;
  const videos = list.tracks.filter((t) => t.kind === "video");
  const audios = list.tracks.filter((t) => t.kind === "audio");
  if (videos.length > 1) report.push({ level: "warn", text: `EDL has one video channel: only ${videos[0].name} was written, ${videos.slice(1).map((t) => t.name).join(", ")} left out.` });
  const events: { track: EditTrack; ch: string }[] = [];
  if (videos[0]) events.push({ track: videos[0], ch: "V" });
  audios.forEach((t, i) => events.push({ track: t, ch: i === 0 ? "A" : `A${i + 1}` }));
  if (audios.length > 4) report.push({ level: "warn", text: "Most EDL readers handle four audio channels; the rest may be ignored." });
  for (const { track, ch } of events) {
    for (const it of track.items) {
      const srcIn = toTc(it.sourceIn, fps);
      const srcOut = toTc(it.sourceIn + it.duration * it.speed, fps);
      const recIn = toTc(it.start, fps);
      const recOut = toTc(it.start + it.duration, fps);
      const reel = reelOf(it.media, n);
      lines.push(`${String(n).padStart(3, "0")}  ${reel.padEnd(8)} ${ch.padEnd(5)} C        ${srcIn} ${srcOut} ${recIn} ${recOut}`);
      if (Math.abs(it.speed - 1) > 1e-6) lines.push(`M2   ${reel.padEnd(8)} ${(it.speed * fps).toFixed(1).padStart(6)}                ${srcIn}`);
      lines.push(`* FROM CLIP NAME: ${it.media}`);
      if (it.name !== it.media) lines.push(`* COMMENT: ${it.name}`);
      lines.push("");
      n++;
    }
  }
  for (const m of list.markers) lines.push(`* MARKER ${toTc(m.time, fps)} ${m.name}`);
  if (list.markers.length) report.push({ level: "info", text: `${list.markers.length} marker${list.markers.length === 1 ? "" : "s"} written as comments; most editors ignore them.` });
  return { text: lines.join("\r\n") + "\r\n", report };
}

/** Read an EDL. Events with a clip name comment keep that file name; otherwise the reel name stands in for it. */
export function parseEdl(text: string, fps: number, name = "Imported EDL"): { list: EditList; report: Note[] } {
  const report: Note[] = [];
  const byCh = new Map<string, EditItem[]>();
  let title = name;
  let last: { it: EditItem; src: string } | null = null;
  let skippedTransitions = 0;
  let bad = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const t = /^TITLE:\s*(.*)$/i.exec(line);
    if (t) {
      title = t[1] || name;
      continue;
    }
    if (/^FCM:/i.test(line)) {
      if (/^FCM:\s*DROP/i.test(line)) report.push({ level: "warn", text: "This list uses drop frame timecode; it was read as non drop frame, so long edits may drift by a few frames." });
      continue;
    }
    const ev = /^(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(?:(\d+)\s+)?(\d+:\d\d:\d\d[:;]\d\d)\s+(\d+:\d\d:\d\d[:;]\d\d)\s+(\d+:\d\d:\d\d[:;]\d\d)\s+(\d+:\d\d:\d\d[:;]\d\d)/.exec(line);
    if (ev) {
      const [, , reel, ch, kind] = ev;
      if (!/^C/i.test(kind)) {
        skippedTransitions++;
        last = null;
        continue;
      }
      const a = fromTc(ev[6], fps), b = fromTc(ev[7], fps), c = fromTc(ev[8], fps), d = fromTc(ev[9], fps);
      if (a === null || b === null || c === null || d === null || d <= c) {
        bad++;
        last = null;
        continue;
      }
      const chan = /^A\d*$/i.test(ch) ? ch.toUpperCase() : "V";
      const dur = d - c;
      const it: EditItem = { name: reel, media: reel, start: c, duration: dur, sourceIn: a, speed: b - a > 0 ? (b - a) / dur : 1 };
      (byCh.get(chan) ?? byCh.set(chan, []).get(chan)!).push(it);
      last = { it, src: ev[6] };
      continue;
    }
    const m2 = /^M2\s+\S+\s+(-?[\d.]+)\s+(\d+:\d\d:\d\d[:;]\d\d)/.exec(line);
    if (m2 && last) {
      const sp = Number(m2[1]) / fps;
      if (sp > 0) last.it.speed = round(sp, 4);
      continue;
    }
    const cn = /^\*\s*FROM CLIP NAME:\s*(.+)$/i.exec(line);
    if (cn && last) {
      last.it.media = cn[1].trim();
      last.it.name = last.it.media;
      continue;
    }
    const cm = /^\*\s*COMMENT:\s*(.+)$/i.exec(line);
    if (cm && last) last.it.name = cm[1].trim();
  }
  if (skippedTransitions) report.push({ level: "warn", text: `${skippedTransitions} dissolve or wipe event${skippedTransitions === 1 ? " was" : "s were"} skipped; the cuts around them are kept.` });
  if (bad) report.push({ level: "warn", text: `${bad} event${bad === 1 ? " was" : "s were"} skipped because the times could not be read.` });
  const order = [...byCh.keys()].sort((x, y) => (x === "V" ? -1 : y === "V" ? 1 : x.localeCompare(y)));
  const tracks: EditTrack[] = order.map((ch) => ({ kind: ch === "V" ? "video" : "audio", name: ch === "V" ? "V1" : ch.replace(/^A$/, "A1"), items: byCh.get(ch)!.sort((a, b) => a.start - b.start) }));
  const duration = Math.max(0, ...tracks.flatMap((t) => t.items.map((i) => i.start + i.duration)));
  if (!tracks.length) report.push({ level: "warn", text: "No edits were found in this file." });
  return { list: { name: title, fps, duration, tracks, markers: [] }, report };
}

export { fromEditList };
