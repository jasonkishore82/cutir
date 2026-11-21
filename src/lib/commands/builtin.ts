import { register, registerSource, type Command } from "./registry";
import { useProject } from "../../store/project";
import { useLibrary } from "../../store/library";
import { useChat } from "../../store/chat";
import { useMedia } from "../../store/media";
import { useSettings } from "../../store/settings";
import { useOverlay } from "../../store/overlay";
import { useWorkspace } from "../../store/workspace";
import { TEXT_SCALES, usePrefs } from "../../store/prefs";
import { downloadProject } from "../../store/project";
import { importMediaFiles, importProjectFile } from "../fileActions";
import { getTime, pause, play, seek, setLoop, shuttle, toggle, usePlayback } from "../transport";
import * as E from "../../timeline/engine";
import { SOURCE_EDITS, loopRange, sourceEdit, sourceEditProblem } from "../../timeline/commands";
import { editTimeline, tlNow, useTimelineUi } from "../../timeline/ui";
import { PAGES, LAYOUT_PRESETS } from "../workspace/pages";
import { registry as aiTools } from "../tools";

/**
 * Phase 27: every action of the editor, registered once. The menu bar, the palette, the shortcut settings and the cheat
 * sheet are all views of this list. Key combos are canonical (see keymap.ts); a command with no `keys` is palette-only.
 */

const emit = (name: string) => window.dispatchEvent(new CustomEvent(name));
const selectedClips = () => useTimelineUi.getState().selected.filter((id) => tlNow().clips.some((c) => c.id === id));
const hasRange = () => tlNow().inPoint !== undefined && tlNow().outPoint !== undefined;
const inEditor = () => useLibrary.getState().screen === "editor";

const file: Command[] = [
  { id: "file.home", title: "All projects", category: "File", run: () => useLibrary.getState().goHome() },
  { id: "file.importMedia", title: "Import media", category: "File", keys: ["Ctrl+I"], run: importMediaFiles, enabled: inEditor },
  { id: "file.importProject", title: "Import project file", category: "File", run: importProjectFile },
  { id: "file.saveProject", title: "Save project file", category: "File", run: () => downloadProject(useProject.getState().project), enabled: inEditor },
  { id: "file.export", title: "Export video", category: "File", keys: ["Ctrl+E"], keywords: "render deliver mp4", run: () => emit("cutir:open-export"), enabled: inEditor },
];

const edit: Command[] = [
  { id: "edit.undo", title: "Undo", category: "Edit", keys: ["Ctrl+Z"], run: () => useProject.getState().undo(), enabled: () => useProject.getState().past.length > 0 },
  { id: "edit.redo", title: "Redo", category: "Edit", keys: ["Ctrl+Shift+Z", "Ctrl+Y"], run: () => useProject.getState().redo(), enabled: () => useProject.getState().future.length > 0 },
  { id: "edit.newChat", title: "New AI chat", category: "Edit", run: () => { useProject.setState({ chatOpen: true }); useChat.getState().newChat(); } },
  {
    id: "edit.bladeAtPlayhead",
    title: "Cut at the playhead",
    category: "Edit",
    keys: ["Ctrl+B"],
    keywords: "split blade razor",
    run: () => {
      const sel = selectedClips();
      editTimeline((x) => E.blade(x, getTime(), sel.length ? sel : undefined));
    },
  },
  {
    id: "edit.rippleDelete",
    title: "Ripple delete the selected clips",
    category: "Edit",
    keywords: "remove close gap",
    enabled: () => selectedClips().length > 0,
    run: () => {
      editTimeline((x) => E.rippleDelete(x, selectedClips()));
      useTimelineUi.setState({ selected: [] });
    },
  },
  {
    id: "edit.deleteClips",
    title: "Delete the selected clips (leave a gap)",
    category: "Edit",
    enabled: () => selectedClips().length > 0,
    run: () => {
      editTimeline((x) => E.deleteClips(x, selectedClips()));
      useTimelineUi.setState({ selected: [] });
    },
  },
  { id: "edit.lift", title: "Lift the in to out range", category: "Edit", enabled: hasRange, run: () => editTimeline((x) => E.liftRange(x, x.inPoint!, x.outPoint!)) },
  { id: "edit.extract", title: "Extract the in to out range", category: "Edit", enabled: hasRange, run: () => editTimeline((x) => E.extractRange(x, x.inPoint!, x.outPoint!)) },
  { id: "edit.addVideoTrack", title: "Add a video track", category: "Edit", run: () => editTimeline((x) => E.addTrack(x, "video").tl) },
  { id: "edit.addAudioTrack", title: "Add an audio track", category: "Edit", run: () => editTimeline((x) => E.addTrack(x, "audio").tl) },
  { id: "edit.deselect", title: "Clear the clip selection", category: "Edit", keys: ["Esc"], run: () => (selectedClips().length ? (useTimelineUi.setState({ selected: [] }), true) : false) },
];

const playback: Command[] = [
  { id: "play.toggle", title: "Play or pause", category: "Playback", keys: ["Space"], fromButtons: true, run: () => toggle() },
  {
    id: "play.reverse",
    title: "Shuttle backward (J)",
    category: "Playback",
    keys: ["J"],
    keywords: "rewind jkl",
    run: () => shuttle("J"),
  },
  {
    id: "play.pause",
    title: "Pause the shuttle (K)",
    category: "Playback",
    keys: ["K"],
    keywords: "stop jkl",
    // with a lyric line selected K adds a keyframe instead; that belongs to the lyric timeline, so decline
    run: () => (useProject.getState().selectedLineId ? false : shuttle("K")),
  },
  { id: "play.forward", title: "Shuttle forward (L)", category: "Playback", keys: ["L"], keywords: "fast jkl", run: () => shuttle("L") },
  { id: "play.slowReverse", title: "Shuttle backward, half speed", category: "Playback", keys: ["Shift+J"], run: () => shuttle("J", true) },
  { id: "play.slowForward", title: "Shuttle forward, half speed", category: "Playback", keys: ["Shift+L"], run: () => shuttle("L", true) },
  { id: "play.start", title: "Go to the start", category: "Playback", keys: ["Home"], run: () => seek(0) },
  { id: "play.end", title: "Go to the end", category: "Playback", keys: ["End"], run: () => seek(usePlayback.getState().duration) },
  { id: "play.stop", title: "Stop and return to the start", category: "Playback", run: () => (pause(), seek(0)) },
  { id: "play.loopRange", title: "Loop the in to out range", category: "Playback", enabled: hasRange, run: () => loopRange(true) },
  { id: "play.loopOff", title: "Turn the loop off", category: "Playback", run: () => (setLoop(null), loopRange(false)) },
  { id: "play.playRange", title: "Play the in to out range", category: "Playback", enabled: hasRange, run: () => (loopRange(false), seek(tlNow().inPoint!), play()) },
];

const TOOLS: [string, string, string[], "select" | "trim" | "blade" | "hand" | "zoom"][] = [
  ["tool.select", "Select tool", ["V", "A"], "select"],
  ["tool.trim", "Trim tool", ["T"], "trim"],
  ["tool.blade", "Blade tool", ["B"], "blade"],
  ["tool.hand", "Hand tool", ["H"], "hand"],
  ["tool.zoom", "Zoom tool", ["Z"], "zoom"],
];

const timeline: Command[] = [
  ...TOOLS.map(([id, title, keys, tool]): Command => ({ id, title, category: "Tools", keys, run: () => useTimelineUi.setState({ tool }) })),
  { id: "snap.toggle", title: "Toggle snapping", category: "Tools", keys: ["S", "N"], run: () => useTimelineUi.setState((s) => ({ snapping: !s.snapping })) },
  { id: "snap.beat", title: "Toggle snapping to beats", category: "Tools", keys: ["Shift+N"], run: () => useTimelineUi.setState((s) => ({ beatSnap: !s.beatSnap })) },
  { id: "marker.add", title: "Add a marker at the playhead", category: "Timeline", keys: ["M"], run: () => editTimeline((x) => E.addMarker(x, getTime(), { name: `Marker ${E.userMarkers(x).length + 1}` }).tl) },
  { id: "marker.next", title: "Go to the next marker", category: "Timeline", keys: ["Shift+Down"], run: () => { const m = E.nearMarker(tlNow(), getTime(), 1); if (m) seek(m.time); } },
  { id: "marker.prev", title: "Go to the previous marker", category: "Timeline", keys: ["Shift+Up"], run: () => { const m = E.nearMarker(tlNow(), getTime(), -1); if (m) seek(m.time); } },
  { id: "mark.in", title: "Mark in", category: "Timeline", keys: ["I"], run: () => editTimeline((x) => E.setRange(x, getTime())) },
  { id: "mark.out", title: "Mark out", category: "Timeline", keys: ["O"], run: () => editTimeline((x) => E.setRange(x, undefined, getTime())) },
  { id: "mark.clear", title: "Clear in and out marks", category: "Timeline", keys: ["Alt+X"], run: () => editTimeline((x) => E.setRange(x, null, null)) },
  ...SOURCE_EDITS.map((s): Command => ({
    id: `source.${s.id}`,
    title: `${s.label} the source clip`,
    category: "Timeline",
    keys: [s.key],
    keywords: "source edit three point four point",
    enabled: () => !sourceEditProblem(s.id),
    run: () => {
      const msg = sourceEdit(s.id);
      if (msg) useMedia.setState({ notice: msg });
    },
  })),
];

const pages: Command[] = PAGES.map((p, i): Command => ({
  id: `page.${p.id}`,
  title: `Go to the ${p.label} page`,
  category: "Pages",
  keys: [`Alt+${i + 1}`],
  keywords: p.title,
  enabled: inEditor,
  run: () => useWorkspace.getState().setPage(p.id),
}));

const togglePanel = (key: "left" | "timeline") => () => {
  const w = useWorkspace.getState();
  w.setLayout({ [key]: !w.layout()[key] });
};

const view: Command[] = [
  { id: "view.palette", title: "Command palette", category: "View", keys: ["Ctrl+K"], global: true, keywords: "search commands", run: () => useOverlay.getState().setPalette(!useOverlay.getState().palette) },
  { id: "view.cheat", title: "Keyboard shortcuts cheat sheet", category: "View", keys: ["Ctrl+/", "F1"], global: true, keywords: "help keys", run: () => useOverlay.getState().setCheat(!useOverlay.getState().cheat) },
  { id: "view.fullscreen", title: "Toggle full screen viewer", category: "View", keys: ["F"], run: () => emit("cutir:toggle-fullscreen"), enabled: inEditor },
  { id: "view.inspector", title: "Show or hide the inspector panel", category: "View", keys: ["Ctrl+Alt+I"], run: togglePanel("left"), enabled: inEditor },
  { id: "view.timeline", title: "Show or hide the timeline", category: "View", keys: ["Ctrl+Alt+T"], run: togglePanel("timeline"), enabled: inEditor },
  { id: "view.chat", title: "Show or hide the AI assistant", category: "View", keys: ["Ctrl+Alt+A"], run: () => useProject.getState().toggleChat(), enabled: inEditor },
  { id: "view.resetPage", title: "Reset this page's layout", category: "View", run: () => useWorkspace.getState().resetPage() },
  { id: "view.resetAll", title: "Reset every page's layout", category: "View", run: () => useWorkspace.getState().resetAll() },
  ...LAYOUT_PRESETS.filter((p) => p.id !== "default").map((p): Command => ({ id: `view.layout.${p.id}`, title: `Layout: ${p.name}`, category: "View", run: () => useWorkspace.getState().applyPreset(p.id) })),
  { id: "view.contrast", title: "Toggle high contrast", category: "View", keywords: "accessibility", run: () => usePrefs.getState().setContrast(usePrefs.getState().contrast === "high" ? "normal" : "high") },
  { id: "view.reduceMotion", title: "Toggle reduced motion", category: "View", keywords: "accessibility animation", run: () => usePrefs.getState().setMotion(usePrefs.getState().motion === "reduce" ? "full" : "reduce") },
  {
    id: "view.textBigger",
    title: "Make interface text larger",
    category: "View",
    keywords: "accessibility zoom size",
    run: () => { const n = TEXT_SCALES.find((v) => v > usePrefs.getState().textScale + 0.001); if (n) usePrefs.getState().setTextScale(n); },
  },
  {
    id: "view.textSmaller",
    title: "Make interface text smaller",
    category: "View",
    keywords: "accessibility zoom size",
    run: () => { const n = [...TEXT_SCALES].reverse().find((v) => v < usePrefs.getState().textScale - 0.001); if (n) usePrefs.getState().setTextScale(n); },
  },
];

const settings: Command[] = [
  { id: "settings.ai", title: "AI models and API keys", category: "Settings", run: () => useSettings.getState().openDialog("ai") },
  { id: "settings.editor", title: "Editor preferences", category: "Settings", run: () => useSettings.getState().openDialog("editor") },
  { id: "settings.storage", title: "Storage", category: "Settings", run: () => useSettings.getState().openDialog("storage") },
  { id: "settings.shortcuts", title: "Keyboard shortcuts: rebind, import, export", category: "Settings", run: () => useSettings.getState().openDialog("shortcuts") },
];

/** One command per AI tool: open the assistant with the start of a request, so the AI is reachable from the palette. */
const ai: Command[] = aiTools.all
  .filter((t) => !t.alias)
  .map((t): Command => ({
    id: `ai.${t.name}`,
    title: `Ask AI: ${t.description.split(/(?<=[.!?])\s/)[0].replace(/\.$/, "").slice(0, 90)}`,
    category: "AI",
    keywords: `${t.name} ${t.group} assistant`,
    run: () => {
      useProject.setState({ chatOpen: true });
      useOverlay.getState().setChatDraft(`Use the ${t.name} tool to `);
    },
  }));

register(...file, ...edit, ...playback, ...timeline, ...pages, ...view, ...settings, ...ai);

/** Recent projects are not fixed commands: the list changes, so it is read each time the palette opens. */
registerSource(() =>
  useLibrary
    .getState()
    .entries.slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 8)
    .map((e): Command => ({ id: `project.open.${e.id}`, title: `Open project: ${e.name}`, category: "Project", keywords: "recent", enabled: () => e.id !== useLibrary.getState().currentId || useLibrary.getState().screen === "home", run: () => useLibrary.getState().openProject(e.id) }))
);
