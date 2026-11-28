import type { ProjectDoc } from "../../model/types";
import { useCaptionPrefs } from "../../store/captions";
import { useMedia } from "../../store/media";
import { activeConfig } from "../../store/settings";
import { getAlignSettings } from "../autosync";
import { ASPECT_SIZES } from "../renderer";
import { mixInputs, mixdownChannels } from "../../render/audio";
import { CAPTION_PRESETS, presetById, styleFor } from "./presets";
import { cloudProblem, monoOf, transcribeCloud, transcribeLocal, transcriptToCues, wavBytes } from "./transcribe";
import { LANGUAGES } from "./translate";
import { timelineLength } from "./ops";
import { labelSpeakers } from "./speakers";
import type { Cue } from "./cues";
import { useProject } from "../../store/project";

/** The URL a media item plays from, or undefined while it has not been opened this session. */
export function mediaUrl(doc: ProjectDoc, mediaId: string): string | undefined {
  const m = doc.media.find((x) => x.id === mediaId);
  return m?.url ?? (m?.poolId ? useMedia.getState().urls[m.poolId] : undefined);
}

/** The caption look chosen in the Captions panel, sized for the current frame. */
export function captionLook() {
  const prefs = useCaptionPrefs.getState();
  const s = ASPECT_SIZES[useProject.getState().project.aspect];
  return styleFor(presetById(prefs.presetId) ?? CAPTION_PRESETS[0], prefs.rules, s.w / s.h, prefs.safe);
}

/** The timeline's sound (or one track of it) as 16 kHz mono samples. */
export async function mixMono16k(o: { track?: string; signal?: AbortSignal } = {}): Promise<Float32Array> {
  const d = useProject.getState().doc;
  const len = timelineLength(d);
  if (len <= 0) throw new Error("There is nothing on the timeline to listen to.");
  let inputs = mixInputs(d, undefined, len, (id) => mediaUrl(d, id));
  if (o.track) inputs = inputs.filter((i) => i.trackId === o.track);
  if (!inputs.length) throw new Error("No sound found" + (o.track ? " on that track." : " on the timeline."));
  const ch = await mixdownChannels(inputs, len, 16000, o.signal);
  if (!ch) throw new Error("No sound to listen to.");
  return monoOf(ch[0] as Float32Array, ch[1] as Float32Array);
}

/** Name the speakers of some captions (Speaker 1, Speaker 2...) from the sound. */
export async function detectSpeakers(cues: Cue[], o: { track?: string; signal?: AbortSignal; speakers?: number } = {}): Promise<{ cues: Cue[]; speakers: number }> {
  const samples = await mixMono16k(o);
  return labelSpeakers(cues, samples, 16000, { speakers: o.speakers });
}

export type Transcribed = { cues: Cue[]; language?: string };

/**
 * Mix the timeline's sound (or one track of it) and turn it into captions, with the local helper or the cloud provider
 * chosen in the Captions panel. `onStatus` gets short progress text.
 */
export async function transcribeTimeline(o: { track?: string; signal?: AbortSignal; onStatus?: (text: string) => void; language?: string } = {}): Promise<Transcribed> {
  const prefs = useCaptionPrefs.getState();
  const cfg = activeConfig();
  const say = o.onStatus ?? (() => {});
  const vocab = prefs.vocabulary.split(/[,\n]/).map((v) => v.trim()).filter(Boolean);
  say("Mixing the sound...");
  const d = useProject.getState().doc;
  const len = timelineLength(d);
  if (len <= 0) throw new Error("There is nothing on the timeline to transcribe.");
  let inputs = mixInputs(d, undefined, len, (id) => mediaUrl(d, id));
  if (o.track) inputs = inputs.filter((i) => i.trackId === o.track);
  if (!inputs.length) throw new Error("No sound found" + (o.track ? " on that track." : " on the timeline."));
  const ch = await mixdownChannels(inputs, len, 16000, o.signal);
  if (!ch) throw new Error("No sound to transcribe.");
  const wav = new Blob([wavBytes(monoOf(ch[0] as Float32Array, ch[1] as Float32Array), 16000)], { type: "audio/wav" });
  const language = o.language ?? prefs.language;
  const stages: Record<string, string> = { uploading: "Sending the sound...", separating: "Separating the voice...", loading: "Loading the speech model (the first time downloads it)...", transcribing: "Listening..." };
  let t;
  if (prefs.engine === "cloud") {
    const problem = cloudProblem(cfg);
    if (problem) throw new Error(problem);
    say(`Sending to ${cfg.provider.name}...`);
    t = await transcribeCloud(cfg, wav, { language, vocabulary: vocab }, o.signal);
  } else {
    t = await transcribeLocal(getAlignSettings().url, wav, { language, model: prefs.model, vocabulary: vocab }, o.signal, (stage, pct) => say(`${stages[stage] ?? stage}${pct !== undefined ? ` ${Math.round(pct * 100)}%` : ""}`));
  }
  const cues = transcriptToCues(t, prefs.rules, { vocabulary: vocab });
  if (!cues.length) throw new Error("No speech was found.");
  const lang = t.language && LANGUAGES.some((l) => l.code === t.language) ? t.language : language || undefined;
  return { cues, language: lang };
}
