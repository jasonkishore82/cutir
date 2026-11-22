import type { ScriptHost } from "./api";
import { allCommands, runCommand } from "../commands/registry";
import { applyCalls, registry } from "../tools/index";
import { toolSignature } from "../tools/registry";
import { useProject } from "../../store/project";

/** The real host: the command registry, the assistant's tools (validated, one undo step per call) and a read-only look at the project. */

const ALLOWED = new Set(["View", "Pages", "Tools", "Playback"]);
const offered = () => allCommands().filter((c) => ALLOWED.has(c.category) && !c.id.startsWith("ai.") && !c.id.startsWith("macro.") && !c.id.startsWith("plugin."));

export function realHost(log: (t: string) => void = () => {}): ScriptHost {
  const doc = () => useProject.getState().doc;
  const timeline = () => doc().timelines.find((t) => t.id === doc().activeTimelineId) ?? doc().timelines[0];
  return {
    commands: () => offered().map((c) => ({ id: c.id, title: c.title, category: c.category })),
    run: (id) => (offered().some((c) => c.id === id) ? runCommand(id) : Promise.resolve(false)),
    tools: () => registry.all.map((t) => ({ name: t.name, signature: toolSignature(t) })),
    tool: async (name, args) => {
      const { results } = await applyCalls([{ tool: name, args }]);
      const r = results[0];
      return { ok: !!r?.ok, summary: r?.summary ?? "nothing happened" };
    },
    project: () => {
      const d = doc();
      return { width: d.settings.width, height: d.settings.height, fps: d.settings.fps, activeTimeline: d.activeTimelineId, timelines: d.timelines.map((t) => ({ id: t.id, name: t.name, clips: t.clips.length, tracks: t.tracks.length })), media: d.media.length };
    },
    clips: () => timeline().clips.map((c) => ({ id: c.id, name: c.name ?? null, track: c.trackId, start: c.start, duration: c.duration, speed: c.speed, enabled: c.enabled, kind: c.text ? "text" : c.generator ? "generator" : c.mediaId ? "media" : "other" })),
    log,
  };
}
