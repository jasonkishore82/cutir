import type { ProjectDoc, Timeline } from "../../model/types";
import { fromEditList, toEditList, type Note } from "./common";
import { exportEdl, parseEdl } from "./edl";
import { exportOtio, parseOtio } from "./otio";
import { exportFcpxml } from "./fcpxml";

export type ExportFormat = "otio" | "edl" | "fcpxml";

export const FORMATS: { id: ExportFormat; label: string; ext: string; type: string; note: string }[] = [
  { id: "otio", label: "OpenTimelineIO", ext: "otio", type: "application/json", note: "Resolve, Premiere (with a plug-in), Avid, Nuke. Keeps everything when it comes back to Cutir." },
  { id: "edl", label: "EDL (CMX 3600)", ext: "edl", type: "text/plain", note: "Every editor. Cuts, speed and audio channels only; one video channel." },
  { id: "fcpxml", label: "Final Cut Pro XML", ext: "fcpxml", type: "application/xml", note: "Final Cut Pro and DaVinci Resolve. Export only." },
];

const safeName = (s: string) => s.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "timeline";

/** Write a timeline in one of the formats, with the report of what did not translate. */
export function exportTimeline(doc: ProjectDoc, tl: Timeline, format: ExportFormat): { filename: string; text: string; type: string; report: Note[] } {
  const { list, report } = toEditList(doc, tl);
  const f = FORMATS.find((x) => x.id === format)!;
  const filename = `${safeName(tl.name)}.${f.ext}`;
  if (format === "otio") {
    const o = exportOtio(list);
    return { filename, text: JSON.stringify(o.json, null, 2), type: f.type, report: [...report, ...o.report] };
  }
  if (format === "edl") {
    const o = exportEdl(list);
    return { filename, text: o.text, type: f.type, report: [...report, ...o.report] };
  }
  const o = exportFcpxml(list);
  return { filename, text: o.text, type: f.type, report: [...report, ...o.report] };
}

/** Read an .otio or .edl file into the project as a new timeline. */
export function importTimeline(doc: ProjectDoc, filename: string, text: string): { doc: ProjectDoc; timelineId: string; report: Note[] } {
  const name = filename.replace(/\.[^.]+$/, "");
  const ext = /\.([^.]+)$/.exec(filename)?.[1]?.toLowerCase();
  const fps = doc.settings.fps;
  let parsed: ReturnType<typeof parseEdl>;
  if (ext === "otio" || (ext !== "edl" && text.trimStart().startsWith("{"))) parsed = parseOtio(text, fps);
  else if (ext === "edl" || /^\s*TITLE:/im.test(text)) parsed = parseEdl(text, fps, name);
  else if (ext === "fcpxml" || ext === "xml") throw new Error("FCPXML can be exported but not imported yet. Export OpenTimelineIO from the other editor instead.");
  else throw new Error("Unknown file type. Use an .otio or .edl file.");
  const built = fromEditList(doc, parsed.list);
  if (!parsed.list.name || parsed.list.name === "Imported EDL") built.doc.timelines.find((t) => t.id === built.timelineId)!.name = name || "Imported timeline";
  return { ...built, report: [...parsed.report, ...built.report] };
}

export { toEditList };
