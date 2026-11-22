import { type EditList, type Note } from "./common";

/**
 * Final Cut Pro XML (version 1.9), export only. Every clip hangs off one gap that spans the timeline: video tracks as
 * lanes 1, 2, 3 ... above it and audio tracks as lanes -1, -2 ... below. That keeps each track's timing exact without
 * putting any track in the primary storyline.
 */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function exportFcpxml(list: EditList): { text: string; report: Note[] } {
  const fps = Math.round(list.fps);
  const t = (sec: number) => `${Math.round(sec * fps)}/${fps}s`;
  const names = [...new Set(list.tracks.flatMap((tr) => tr.items.map((i) => i.media)))];
  const assetId = new Map(names.map((n, i) => [n, `r${i + 2}`]));
  const longest = (n: string) => Math.max(...list.tracks.flatMap((tr) => tr.items.filter((i) => i.media === n).map((i) => i.sourceIn + i.duration * i.speed)), 1);
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', "<!DOCTYPE fcpxml>", '<fcpxml version="1.9">', "  <resources>"];
  out.push(`    <format id="r1" name="FFVideoFormat${fps}p" frameDuration="1/${fps}s" width="1920" height="1080"/>`);
  for (const n of names) {
    const hasVideo = list.tracks.some((tr) => tr.kind === "video" && tr.items.some((i) => i.media === n));
    out.push(`    <asset id="${assetId.get(n)}" name="${esc(n)}" start="0s" duration="${t(longest(n))}" hasVideo="${hasVideo ? 1 : 0}" hasAudio="1" format="r1">`);
    out.push(`      <media-rep kind="original-media" src="${esc(`file:///${encodeURI(n)}`)}"/>`);
    out.push("    </asset>");
  }
  out.push("  </resources>", "  <library>", `    <event name="${esc(list.name)}">`, `      <project name="${esc(list.name)}">`);
  out.push(`        <sequence format="r1" duration="${t(Math.max(list.duration, 1 / fps))}" tcStart="0s" tcFormat="NDF">`, "          <spine>");
  out.push(`            <gap name="Gap" offset="0s" start="0s" duration="${t(Math.max(list.duration, 1 / fps))}">`);
  let v = 0, a = 0;
  for (const tr of list.tracks) {
    const lane = tr.kind === "video" ? ++v : -++a;
    for (const it of tr.items) {
      const speed = Math.abs(it.speed - 1) > 1e-6;
      out.push(`              <asset-clip ref="${assetId.get(it.media)}" lane="${lane}" name="${esc(it.name)}" offset="${t(it.start)}" start="${t(it.sourceIn)}" duration="${t(it.duration)}"${tr.kind === "audio" ? ' audioRole="dialogue"' : ""}>`);
      if (speed) out.push(`                <timeMap><timept time="0s" value="0s" interp="linear"/><timept time="${t(it.duration)}" value="${t(it.duration * it.speed)}" interp="linear"/></timeMap>`);
      out.push("              </asset-clip>");
    }
  }
  for (const m of list.markers) out.push(`              <marker start="${t(m.time)}" duration="1/${fps}s" value="${esc(m.name)}"${m.note ? ` note="${esc(m.note)}"` : ""}/>`);
  out.push("            </gap>", "          </spine>", "        </sequence>", "      </project>", "    </event>", "  </library>", "</fcpxml>");
  const report: Note[] = [{ level: "info", text: "FCPXML is export only. Open it in Final Cut Pro or DaVinci Resolve; use OpenTimelineIO to bring an edit back." }];
  return { text: out.join("\n") + "\n", report };
}
