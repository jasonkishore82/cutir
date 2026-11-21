import { useEffect, useMemo, useRef, useState } from "react";
import { Card } from "./ui";
import { useProject, uid, linesOfLayer, type Layer } from "../store/project";
import { useMedia } from "../store/media";
import { useCaptionPrefs } from "../store/captions";
import { activeConfig } from "../store/settings";
import { activeTimeline } from "../model/convert";
import { editTimeline, useTimelineUi } from "../timeline/ui";
import * as E from "../timeline/engine";
import { ASPECT_SIZES } from "../lib/renderer";
import { getAlignSettings } from "../lib/autosync";
import { getTime, pause, play, seek, usePlayback } from "../lib/transport";
import { mixInputs, mixdownChannels } from "../render/audio";
import { CUE_FORMATS, parseCues, serializeCues, type Cue, type CueFormat } from "../lib/captions/cues";
import { RULE_PRESETS, checkCues, fixCues, type CaptionRules } from "../lib/captions/checks";
import { CAPTION_PRESETS, SAFE_LABEL, presetById, styleFor, type SafeArea } from "../lib/captions/presets";
import { DEFAULT_FILLERS, OPTIONAL_FILLERS, applyCutsToCues, cuesFromWords, findFillers, findPauses, flatWords, planCuts, totalOf, type Range } from "../lib/captions/transcript";
import { cloudProblem, monoOf, transcribeCloud, transcribeLocal, transcriptToCues, wavBytes } from "../lib/captions/transcribe";
import { LANGUAGES, languageName, translateCues, withTranslation } from "../lib/captions/translate";
import { configProblem } from "../lib/llm";
import { cutDoc, linesToCues, timelineLength, withLayerCues } from "../lib/captions/ops";
import { downloadBlob } from "../lib/exporter";

const btn = "rounded-md border border-edge px-2 py-0.5 text-[11px] text-gray-300 hover:bg-white/10 disabled:opacity-40";
const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const safeName = (s: string) => s.replace(/[^\w-]+/g, "_");

/** The caption (subtitle) track being worked on and its cues. */
function useCaptionLayer() {
  const project = useProject((s) => s.project);
  const activeLayerId = useProject((s) => s.activeLayerId);
  const layer = project.layers.find((l) => l.id === activeLayerId) ?? project.layers[0];
  const lines = useMemo(() => [...linesOfLayer(project, layer.id)].sort((a, b) => a.start - b.start), [project, layer.id]);
  const cues = useMemo(() => linesToCues(lines), [lines]);
  return { project, layer, lines, cues };
}

const setCues = (layerId: string, cues: Cue[], patch?: Partial<Layer>) => useProject.getState().update((p) => withLayerCues(p, layerId, cues, patch));
const aspectOf = () => {
  const s = ASPECT_SIZES[useProject.getState().project.aspect];
  return s.w / s.h;
};
const lookFor = () => {
  const prefs = useCaptionPrefs.getState();
  return styleFor(presetById(prefs.presetId) ?? CAPTION_PRESETS[0], prefs.rules, aspectOf(), prefs.safe);
};

/** A new caption track with these cues, in the chosen look, made the active one. */
function addCaptionTrack(name: string, cues: Cue[], lang?: string): string {
  const id = uid();
  useProject.getState().update((p) => withLayerCues(p, id, cues, { name, lang, visible: true, locked: false, style: lookFor() }));
  useProject.getState().setActiveLayer(id);
  return id;
}

export default function CaptionsPanel() {
  return (
    <>
      <TranscribeCard />
      <TracksCard />
      <TranscriptCard />
      <ChecksCard />
      <TranslateCard />
      <FilesCard />
    </>
  );
}

/* ---------- transcription ---------- */

function TranscribeCard() {
  const prefs = useCaptionPrefs();
  const doc = useProject((s) => s.doc);
  const tl = activeTimeline(doc);
  const [track, setTrack] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const ctl = useRef<AbortController | null>(null);
  const cfg = activeConfig();
  const sources = tl.tracks.filter((t) => t.kind !== "subtitle" && tl.clips.some((c) => c.trackId === t.id && !c.fill));
  const vocab = () => prefs.vocabulary.split(/[,\n]/).map((v) => v.trim()).filter(Boolean);

  const run = async () => {
    setBusy(true);
    setMsg("Mixing the sound...");
    ctl.current = new AbortController();
    const { signal } = ctl.current;
    try {
      const d = useProject.getState().doc;
      const len = timelineLength(d);
      if (len <= 0) throw new Error("There is nothing on the timeline to transcribe.");
      const urls = useMedia.getState().urls;
      const urlOf = (mediaId: string) => {
        const m = d.media.find((x) => x.id === mediaId);
        return m?.url ?? (m?.poolId ? urls[m.poolId] : undefined);
      };
      let inputs = mixInputs(d, undefined, len, urlOf);
      if (track) inputs = inputs.filter((i) => i.trackId === track);
      if (!inputs.length) throw new Error("No sound found" + (track ? " on that track." : " on the timeline."));
      const ch = await mixdownChannels(inputs, len, 16000, signal);
      if (!ch) throw new Error("No sound to transcribe.");
      const wav = new Blob([wavBytes(monoOf(ch[0] as Float32Array, ch[1] as Float32Array), 16000)], { type: "audio/wav" });
      const stages: Record<string, string> = { uploading: "Sending the sound...", separating: "Separating the voice...", loading: "Loading the speech model (the first time downloads it)...", transcribing: "Listening..." };
      const t =
        prefs.engine === "cloud"
          ? (setMsg(`Sending to ${cfg.provider.name}...`), await transcribeCloud(cfg, wav, { language: prefs.language, vocabulary: vocab() }, signal))
          : await transcribeLocal(getAlignSettings().url, wav, { language: prefs.language, model: prefs.model, vocabulary: vocab() }, signal, (stage, pct) => setMsg(`${stages[stage] ?? stage}${pct !== undefined ? ` ${Math.round(pct * 100)}%` : ""}`));
      const cues = transcriptToCues(t, prefs.rules, { vocabulary: vocab() });
      if (!cues.length) throw new Error("No speech was found.");
      const lang = t.language && LANGUAGES.some((l) => l.code === t.language) ? t.language : prefs.language || undefined;
      addCaptionTrack(lang ? `Captions (${languageName(lang)})` : "Captions", cues, lang);
      setMsg(`Made ${cues.length} captions${t.language ? `, language: ${languageName(t.language)}` : ""}. Edit them in the transcript below.`);
    } catch (e) {
      setMsg((e as Error).name === "AbortError" ? "Cancelled." : (e as Error).message || "Transcription failed.");
    } finally {
      setBusy(false);
      ctl.current = null;
    }
  };

  const problem = prefs.engine === "cloud" ? cloudProblem(cfg) : "";
  return (
    <Card title="Transcribe" hint="Turn speech into captions with word timing. Runs on this computer with the helper, or with OpenAI or Groq from your AI settings.">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-400">
        <label className="flex items-center gap-1">Engine
          <select className="field !w-auto !py-0.5" value={prefs.engine} onChange={(e) => prefs.set({ engine: e.target.value as "local" | "cloud" })} aria-label="Speech engine">
            <option value="local">Local helper (Whisper)</option>
            <option value="cloud">Cloud ({cfg.provider.name})</option>
          </select>
        </label>
        {prefs.engine === "local" && (
          <label className="flex items-center gap-1">Model
            <select className="field !w-auto !py-0.5" value={prefs.model} onChange={(e) => prefs.set({ model: e.target.value })} aria-label="Whisper model">
              {["tiny", "base", "small", "medium", "large-v3"].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
        )}
        <label className="flex items-center gap-1">Language
          <select className="field !w-auto !py-0.5" value={prefs.language} onChange={(e) => prefs.set({ language: e.target.value })} aria-label="Spoken language">
            <option value="">Detect</option>
            {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1">From
          <select className="field !w-auto !py-0.5" value={track} onChange={(e) => setTrack(e.target.value)} aria-label="Which sound to transcribe">
            <option value="">Everything you hear</option>
            {sources.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
      </div>
      <label className="block text-[11px] text-gray-400">Names and words to spell right
        <textarea className="field mt-1 h-12 w-full resize-y text-xs" placeholder="Kubernetes, Dr. Okafor, Cutir" value={prefs.vocabulary} onChange={(e) => prefs.set({ vocabulary: e.target.value })} />
      </label>
      <div className="flex items-center gap-2">
        {busy ? <button className={`${btn} border-red-700 text-red-300`} onClick={() => ctl.current?.abort()}>Cancel</button> : <button className={btn} disabled={!!problem} onClick={run}>Transcribe</button>}
        {problem && <span className="text-[11px] text-yellow-400">{problem}</span>}
      </div>
      {msg && <p className="text-[11px] text-gray-400" role="status">{msg}</p>}
      <p className="text-[10px] text-gray-500">Speaker names are set by hand in the transcript: select words and name the speaker.</p>
    </Card>
  );
}

/* ---------- caption tracks and their look ---------- */

function TracksCard() {
  const prefs = useCaptionPrefs();
  const { project, layer } = useCaptionLayer();
  const setActive = useProject((s) => s.setActiveLayer);
  const patch = (id: string, p: Partial<Layer>) => useProject.getState().update((x) => ({ ...x, layers: x.layers.map((l) => (l.id === id ? { ...l, ...p } : l)) }));
  const remove = (id: string) =>
    useProject.getState().update((x) => (x.layers.length <= 1 ? x : { ...x, layers: x.layers.filter((l) => l.id !== id), lines: x.lines.filter((l) => (l.layerId ?? x.layers[0].id) !== id) }));
  const applyLook = () => patch(layer.id, { style: lookFor() });
  return (
    <Card title="Caption tracks" hint="One track per language. A visible track is burned into the picture on export; soft tracks are chosen in the export window.">
      <div className="space-y-1">
        {project.layers.map((l) => (
          <div key={l.id} className={`flex items-center gap-1 rounded-md border px-1.5 py-1 text-[11px] ${l.id === layer.id ? "border-accent" : "border-edge"}`}>
            <input type="radio" name="cap-layer" checked={l.id === layer.id} onChange={() => setActive(l.id)} aria-label={`Work on ${l.name}`} />
            <input className="field !w-28 !py-0.5" value={l.name} onChange={(e) => patch(l.id, { name: e.target.value })} aria-label="Track name" />
            <select className="field !w-auto !py-0.5" value={l.lang ?? ""} onChange={(e) => patch(l.id, { lang: e.target.value || undefined })} aria-label="Track language">
              <option value="">language</option>
              {LANGUAGES.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}
            </select>
            <label className="flex items-center gap-0.5 text-gray-400"><input type="checkbox" checked={l.visible} onChange={(e) => patch(l.id, { visible: e.target.checked })} />show</label>
            <span className="ml-auto text-gray-500">{linesOfLayer(project, l.id).length}</span>
            <button className={btn} disabled={project.layers.length <= 1} onClick={() => remove(l.id)} aria-label={`Delete ${l.name}`}>×</button>
          </div>
        ))}
        <button className={btn} onClick={() => addCaptionTrack(`Captions ${project.layers.length + 1}`, [])}>+ Add a track</button>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-400">
        <label className="flex items-center gap-1">Look
          <select className="field !w-auto !py-0.5" value={prefs.presetId} onChange={(e) => prefs.set({ presetId: e.target.value })} aria-label="Caption look">
            {CAPTION_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1">Safe area
          <select className="field !w-auto !py-0.5" value={prefs.safe} onChange={(e) => prefs.set({ safe: e.target.value as SafeArea })} aria-label="Safe area">
            {(Object.keys(SAFE_LABEL) as SafeArea[]).map((s) => <option key={s} value={s}>{SAFE_LABEL[s]}</option>)}
          </select>
        </label>
        <button className={btn} onClick={applyLook} title="Set the chosen look on the selected track, sized so a full line stays inside the safe area">Apply to "{layer.name}"</button>
      </div>
      <p className="text-[10px] text-gray-500">{presetById(prefs.presetId)?.hint}. The size is chosen so {prefs.rules.maxChars} characters fit inside the safe width; captions sit on the 90% line at the bottom.</p>
    </Card>
  );
}

/* ---------- the transcript ---------- */

function TranscriptCard() {
  const prefs = useCaptionPrefs();
  const { project, layer, lines, cues } = useCaptionLayer();
  const words = useMemo(() => flatWords(cues), [cues]);
  const [sel, setSel] = useState<{ a: number; b: number } | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [speaker, setSpeaker] = useState("");
  const [useFillers, setUseFillers] = useState(true);
  const [usePauses, setUsePauses] = useState(true);
  const [now, setNow] = useState(-1);
  const [msg, setMsg] = useState("");
  const stopPreview = useRef<(() => void) | null>(null);
  const playing = usePlayback((s) => s.playing);

  useEffect(() => setSel(null), [layer.id]);
  useEffect(() => () => stopPreview.current?.(), []);
  // the word being spoken
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      const t = getTime();
      const i = words.findIndex((w) => t >= w.start && t < w.end + 0.15);
      setNow(i);
    }, 120);
    return () => clearInterval(id);
  }, [playing, words]);

  const fillerList = useMemo(() => prefs.fillers.split(",").map((f) => f.trim()).filter(Boolean), [prefs.fillers]);
  const fillerIdx = useMemo(() => (useFillers ? findFillers(words, fillerList) : []), [words, fillerList, useFillers]);
  const pauseRanges = useMemo(() => (usePauses ? findPauses(words, { min: prefs.pauseMin, keep: prefs.pauseKeep }) : []), [words, usePauses, prefs.pauseMin, prefs.pauseKeep]);
  const auto = useMemo(() => planCuts(words, fillerIdx, pauseRanges), [words, fillerIdx, pauseRanges]);
  const fillerSet = useMemo(() => new Set(fillerIdx), [fillerIdx]);
  // flat word indices of each cue (words are in cue order), so drawing is linear in the number of words
  const firstWord = useMemo(() => {
    const f: number[] = new Array(cues.length + 1).fill(words.length);
    for (let i = words.length - 1; i >= 0; i--) f[words[i].cue] = i;
    for (let c = cues.length - 1; c >= 0; c--) f[c] = Math.min(f[c], f[c + 1]);
    return f;
  }, [cues.length, words]);
  const cueWords = (ci: number) => Array.from({ length: Math.max(0, firstWord[ci + 1] - firstWord[ci]) }, (_, k) => ({ w: words[firstWord[ci] + k], i: firstWord[ci] + k }));
  const picked = sel ? Array.from({ length: Math.abs(sel.b - sel.a) + 1 }, (_, k) => Math.min(sel.a, sel.b) + k) : [];

  const cutRanges = (ranges: Range[], picture: boolean) => {
    if (!ranges.length) return;
    useProject.getState().editDoc((d) => cutDoc(d, ranges, { picture }));
    setSel(null);
    setMsg(`${picture ? "Cut" : "Removed"} ${mmssd(totalOf(ranges))} of ${picture ? "picture, sound and captions" : "caption text"}. Undo brings it back.`);
  };
  const mmssd = (t: number) => `${t.toFixed(1)} s`;
  const deleteSelected = (picture: boolean) => {
    if (!picked.length) return;
    if (picture) cutRanges(planCuts(words, picked), true);
    else {
      // text only: the words go, the time stays
      const drop = new Set(picked.map((i) => `${words[i].cue}:${words[i].index}`));
      const next: Cue[] = [];
      cues.forEach((c, ci) => {
        const ws = cueWords(ci).map((x) => x.w).filter((w) => !drop.has(`${w.cue}:${w.index}`));
        if (!ws.length) return;
        next.push({ ...c, start: ws[0].start, end: ws[ws.length - 1].end, text: ws.map((w) => w.text).join(" "), words: ws.map(({ text, start, end }) => ({ text, start, end })) });
      });
      setCues(layer.id, next);
      setSel(null);
    }
  };
  const editWord = (i: number, text: string) => {
    const w = words[i];
    const clean = text.trim();
    setEditing(null);
    if (!clean || clean === w.text) return;
    const next = cues.map((c, ci) => {
      if (ci !== w.cue) return c;
      const ws = flatWords([c]).map((x, k) => ({ text: k === w.index ? clean : x.text, start: x.start, end: x.end }));
      return { ...c, text: ws.map((x) => x.text).join(" "), words: ws };
    });
    setCues(layer.id, next);
  };
  const setSpeakerOnSelection = () => {
    if (!picked.length) return;
    const which = new Set(picked.map((i) => words[i].cue));
    setCues(layer.id, cues.map((c, ci) => (which.has(ci) ? { ...c, speaker: speaker.trim() || undefined } : c)));
  };
  const markRange = () => {
    if (!picked.length) return;
    const a = words[picked[0]].start;
    const b = words[picked[picked.length - 1]].end;
    editTimeline((t) => E.setRange(t, a, b));
    const tl = activeTimeline(useProject.getState().doc);
    useTimelineUi.setState({ selected: E.clipsInRange(tl, a, b, tl.tracks.filter((t) => t.kind !== "subtitle").map((t) => t.id)) });
    setMsg(`In and Out set to ${mmss(a)} to ${mmss(b)}, and the clips in that range are selected.`);
  };
  const reflow = () => {
    const next = fixCues(cuesFromWords(words.map((w) => ({ text: w.text, start: w.start, end: w.end, speaker: w.speaker })), { pause: 0.8, maxChars: prefs.rules.maxChars * prefs.rules.maxLines }), prefs.rules).cues;
    setCues(layer.id, next);
    setMsg(`Split into ${next.length} captions.`);
  };
  const preview = () => {
    if (stopPreview.current) {
      stopPreview.current();
      stopPreview.current = null;
      return;
    }
    if (!auto.length) return;
    seek(Math.max(0, auto[0].start - 2));
    play();
    const end = auto[auto.length - 1].end + 3;
    const id = setInterval(() => {
      const t = getTime();
      const r = auto.find((x) => t >= x.start && t < x.end - 0.02);
      if (r) seek(r.end);
      if (t > end) stop();
    }, 40);
    const stop = () => {
      clearInterval(id);
      pause();
      stopPreview.current = null;
    };
    stopPreview.current = stop;
  };

  const onWordClick = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest("[data-i]") as HTMLElement | null;
    if (!el) return;
    const i = Number(el.dataset.i);
    if (e.shiftKey && sel) setSel({ a: sel.a, b: i });
    else {
      setSel({ a: i, b: i });
      seek(words[i].start);
    }
  };

  if (!words.length)
    return (
      <Card title="Transcript" hint="Words of the selected caption track. Delete words to cut what is said from the picture and sound.">
        <p className="text-[12px] text-gray-500">No captions in "{layer.name}" yet. Transcribe, import a file or type lines in the Lyrics tab.</p>
      </Card>
    );

  return (
    <Card title="Transcript" hint={`"${layer.name}": click a word to jump there, shift-click to select a run, Delete to cut it from the video and audio. Double-click a word to correct it.`}>
      <div
        className="max-h-64 space-y-1.5 overflow-y-auto rounded-md border border-edge bg-black/30 p-2 text-[12px] leading-6 text-gray-200 outline-none"
        tabIndex={0}
        onClick={onWordClick}
        onKeyDown={(e) => {
          if ((e.key === "Delete" || e.key === "Backspace") && picked.length) (e.preventDefault(), deleteSelected(!e.shiftKey));
        }}
        aria-label="Transcript"
      >
        {cues.map((c, ci) => (
          <p key={ci}>
            <button className="mr-1.5 text-[10px] text-gray-500 hover:text-gray-200" onClick={() => seek(c.start)} aria-label={`Go to ${mmss(c.start)}`}>{mmss(c.start)}</button>
            {c.speaker && <span className="mr-1 rounded bg-white/10 px-1 text-[10px] text-sky-300">{c.speaker}</span>}
            {cueWords(ci).map(({ w, i }) => {
              const on = picked.includes(i);
              if (editing === i)
                return <input key={i} autoFocus className="field !inline-block !w-24 !py-0" defaultValue={w.text} onBlur={(e) => editWord(i, e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") editWord(i, (e.target as HTMLInputElement).value); if (e.key === "Escape") setEditing(null); }} />;
              const gapAfter = words[i + 1] ? words[i + 1].start - w.end : 0;
              const longPause = usePauses && gapAfter >= prefs.pauseMin;
              return (
                <span key={i}>
                  <span data-i={i} onDoubleClick={() => setEditing(i)} className={`cursor-pointer rounded px-0.5 ${on ? "bg-accent/50 text-white" : i === now ? "bg-white/20" : ""} ${fillerSet.has(i) ? "text-red-300 underline decoration-red-400/70" : ""}`}>{w.text}</span>
                  {longPause ? <span className="mx-0.5 text-[10px] text-yellow-400" title={`${gapAfter.toFixed(1)} s pause`}>[{gapAfter.toFixed(1)}s]</span> : " "}
                </span>
              );
            })}
          </p>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <button className={btn} disabled={!picked.length} onClick={() => deleteSelected(true)} title="Remove the words and the time they take from every track">Delete (cut video and audio)</button>
        <button className={btn} disabled={!picked.length} onClick={() => deleteSelected(false)} title="Remove the words from the caption only; picture and sound stay">Delete text only</button>
        <button className={btn} disabled={!picked.length} onClick={markRange} title="Set In and Out to the selected words and select the clips there">Select range</button>
        <span className="text-[10px] text-gray-500">{picked.length ? `${picked.length} word${picked.length === 1 ? "" : "s"} selected` : `${words.length} words`}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1 text-[11px] text-gray-400">
        <input className="field !w-28 !py-0.5" placeholder="Speaker name" value={speaker} onChange={(e) => setSpeaker(e.target.value)} aria-label="Speaker name" />
        <button className={btn} disabled={!picked.length} onClick={setSpeakerOnSelection}>Set speaker</button>
        <button className={btn} onClick={reflow} title="Rebuild the captions from the words: new lines at pauses and sentence ends, within the rules">Re-split captions</button>
      </div>

      <div className="space-y-1 border-t border-edge pt-2">
        <div className="text-[12px] text-gray-300">Remove fillers and pauses</div>
        <label className="flex items-center gap-1 text-[11px] text-gray-400"><input type="checkbox" checked={useFillers} onChange={(e) => setUseFillers(e.target.checked)} /> Filler words
          <input className="field !py-0.5 text-xs" style={{ flex: 1 }} value={prefs.fillers} onChange={(e) => prefs.set({ fillers: e.target.value })} aria-label="Filler words" />
        </label>
        <div className="flex flex-wrap gap-1 text-[10px]">
          {OPTIONAL_FILLERS.map((f) => {
            const has = fillerList.map((x) => x.toLowerCase()).includes(f);
            return <button key={f} className={`rounded border px-1 ${has ? "border-accent text-accent" : "border-edge text-gray-500"}`} onClick={() => prefs.set({ fillers: (has ? fillerList.filter((x) => x.toLowerCase() !== f) : [...fillerList, f]).join(", ") })}>{has ? "−" : "+"} {f}</button>;
          })}
          <button className="rounded border border-edge px-1 text-gray-500" onClick={() => prefs.set({ fillers: DEFAULT_FILLERS.join(", ") })}>reset</button>
        </div>
        <label className="flex flex-wrap items-center gap-1 text-[11px] text-gray-400"><input type="checkbox" checked={usePauses} onChange={(e) => setUsePauses(e.target.checked)} /> Pauses longer than
          <input className="field !w-14 !py-0.5" type="number" min={0.3} max={5} step={0.1} value={prefs.pauseMin} onChange={(e) => prefs.set({ pauseMin: Math.max(0.3, Number(e.target.value) || 0.8) })} aria-label="Shortest pause to cut" /> s, keep
          <input className="field !w-14 !py-0.5" type="number" min={0} max={1} step={0.05} value={prefs.pauseKeep} onChange={(e) => prefs.set({ pauseKeep: Math.max(0, Math.min(1, Number(e.target.value) || 0)) })} aria-label="Pause to keep" /> s
        </label>
        <div className="flex flex-wrap items-center gap-1">
          <button className={btn} disabled={!auto.length} onClick={preview}>{playing && stopPreview.current ? "Stop preview" : "Preview (plays without them)"}</button>
          <button className={btn} disabled={!auto.length} onClick={() => cutRanges(auto, true)}>Remove all</button>
          <span className="text-[10px] text-gray-500">{fillerIdx.length} filler{fillerIdx.length === 1 ? "" : "s"}, {pauseRanges.length} pause{pauseRanges.length === 1 ? "" : "s"}, {mmssd(totalOf(auto))} saved</span>
        </div>
      </div>
      {msg && <p className="text-[11px] text-gray-400" role="status">{msg}</p>}
      <span hidden>{project.layers.length}{lines.length}</span>
    </Card>
  );
}

/* ---------- checks ---------- */

function ChecksCard() {
  const prefs = useCaptionPrefs();
  const { layer, lines, cues } = useCaptionLayer();
  const rules = prefs.rules;
  const issues = useMemo(() => checkCues(cues, rules), [cues, rules]);
  const setRule = (k: keyof CaptionRules, v: number) => prefs.set({ rules: { ...rules, [k]: v } });
  const fixAll = () => {
    const r = fixCues(cues, rules);
    setCues(layer.id, r.cues);
  };
  const fixOne = (i: number) => {
    const r = fixCues([cues[i]], rules, { nextStart: cues[i + 1]?.start });
    setCues(layer.id, [...cues.slice(0, i), ...r.cues, ...cues.slice(i + 1)]);
  };
  const go = (i: number) => {
    seek(cues[i].start);
    if (lines[i]) useProject.getState().selectMany([lines[i].id]);
  };
  const num = (k: keyof CaptionRules, label: string, step: number, min: number, max: number) => (
    <label className="flex items-center gap-1">{label}
      <input className="field !w-14 !py-0.5" type="number" step={step} min={min} max={max} value={rules[k]} onChange={(e) => setRule(k, Number(e.target.value) || rules[k])} aria-label={label} />
    </label>
  );
  return (
    <Card title="Checks" hint={`Reading speed, time on screen, overlaps and line length for "${layer.name}".`}>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-400">
        <select className="field !w-auto !py-0.5" value="" onChange={(e) => { const p = RULE_PRESETS.find((x) => x.id === e.target.value); if (p) prefs.set({ rules: p.rules }); }} aria-label="Rule set">
          <option value="">Rule set...</option>
          {RULE_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        {num("maxCps", "chars/s", 1, 5, 40)}
        {num("minDuration", "min s", 0.1, 0.2, 5)}
        {num("maxDuration", "max s", 0.5, 1, 20)}
        {num("maxLines", "lines", 1, 1, 4)}
        {num("maxChars", "chars/line", 1, 10, 80)}
      </div>
      <div className="flex items-center gap-2">
        <button className={btn} disabled={!issues.length} onClick={fixAll}>Fix all ({issues.length})</button>
        <span className="text-[11px] text-gray-500">{cues.length ? (issues.length ? `${issues.length} problem${issues.length === 1 ? "" : "s"} in ${new Set(issues.map((i) => i.index)).size} captions` : "No problems found.") : "No captions yet."}</span>
      </div>
      {issues.length > 0 && (
        <ul className="max-h-40 space-y-0.5 overflow-y-auto text-[11px]">
          {issues.map((it, k) => (
            <li key={k} className="flex items-center gap-1">
              <button className="text-gray-500 hover:text-gray-200" onClick={() => go(it.index)} aria-label={`Go to caption ${it.index + 1}`}>{it.index + 1} · {mmss(cues[it.index].start)}</button>
              <span className="flex-1 truncate text-gray-300" title={it.message}>{it.message}</span>
              <button className={btn} onClick={() => fixOne(it.index)}>Fix</button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ---------- translation ---------- */

function TranslateCard() {
  const { project, layer, cues } = useCaptionLayer();
  const prefs = useCaptionPrefs();
  const [to, setTo] = useState("es");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [pairId, setPairId] = useState("");
  const ctl = useRef<AbortController | null>(null);
  const cfg = activeConfig();
  const others = project.layers.filter((l) => l.id !== layer.id);
  const pair = others.find((l) => l.id === pairId) ?? others[0];
  const pairCues = useMemo(() => (pair ? linesToCues(linesOfLayer(project, pair.id).sort((a, b) => a.start - b.start)) : []), [project, pair]);

  const run = async () => {
    setBusy(true);
    setMsg("Translating...");
    ctl.current = new AbortController();
    try {
      const out = await translateCues(cfg, cues, to, { from: layer.lang, signal: ctl.current.signal, onProgress: (d, t) => setMsg(`Translating ${d} of ${t}...`) });
      const id = addCaptionTrack(languageName(to), withTranslation(cues, out, prefs.rules), to);
      setPairId(id);
      useProject.getState().setActiveLayer(layer.id);
      setMsg(`Made a ${languageName(to)} track with the same timing. Check and edit it below.`);
    } catch (e) {
      setMsg((e as Error).name === "AbortError" ? "Cancelled." : (e as Error).message);
    } finally {
      setBusy(false);
      ctl.current = null;
    }
  };
  // the translated cue that overlaps this source cue the most
  const match = (c: Cue): number => {
    let best = -1, bestO = 0;
    pairCues.forEach((p, i) => {
      const o = Math.min(c.end, p.end) - Math.max(c.start, p.start);
      if (o > bestO) (bestO = o), (best = i);
    });
    return best;
  };
  const edit = (i: number, text: string) => pair && setCues(pair.id, pairCues.map((c, k) => (k === i ? { ...c, text } : c)));
  const problem = configProblem(cfg);
  return (
    <Card title="Translate" hint={`Make a second track from "${layer.name}" in another language with your AI provider, then edit it side by side.`}>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-400">
        <label className="flex items-center gap-1">Into
          <select className="field !w-auto !py-0.5" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Translate into">
            {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
          </select>
        </label>
        {busy ? <button className={`${btn} border-red-700 text-red-300`} onClick={() => ctl.current?.abort()}>Cancel</button> : <button className={btn} disabled={!cues.length || !!problem} onClick={run}>Translate</button>}
        {problem && <span className="text-yellow-400">{problem}</span>}
      </div>
      {msg && <p className="text-[11px] text-gray-400" role="status">{msg}</p>}
      {pair && cues.length > 0 && (
        <div className="space-y-1">
          <label className="flex items-center gap-1 text-[11px] text-gray-400">Side by side with
            <select className="field !w-auto !py-0.5" value={pair.id} onChange={(e) => setPairId(e.target.value)} aria-label="Translation track">
              {others.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
          <div className="max-h-56 space-y-1 overflow-y-auto">
            {cues.map((c, i) => {
              const m = match(c);
              return (
                <div key={i} className="grid grid-cols-2 gap-1 text-[11px]">
                  <button className="rounded bg-black/30 p-1 text-left text-gray-300 hover:bg-white/10" onClick={() => seek(c.start)}>{c.text}</button>
                  {m >= 0 ? <textarea className="field !py-0.5 text-[11px]" rows={Math.max(1, c.text.split("\n").length)} value={pairCues[m].text} onChange={(e) => edit(m, e.target.value)} aria-label={`Translation of caption ${i + 1}`} /> : <span className="p-1 text-gray-600">(no match)</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}

/* ---------- import and export ---------- */

function FilesCard() {
  const { project, layer, cues } = useCaptionLayer();
  const [format, setFormat] = useState<CueFormat>("srt");
  const [into, setInto] = useState<"new" | "replace">("new");
  const [msg, setMsg] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const size = ASPECT_SIZES[project.aspect];

  const importFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    let count = 0;
    for (const f of Array.from(files)) {
      const parsed = parseCues(f.name, await f.text());
      if (!parsed.length) {
        setMsg(`No timed captions found in ${f.name}.`);
        continue;
      }
      // "movie.es.srt" is Spanish
      const lang = /\.([a-z]{2})\.[a-z]+$/i.exec(f.name)?.[1]?.toLowerCase();
      const known = lang && LANGUAGES.some((l) => l.code === lang) ? lang : undefined;
      if (into === "replace" && count === 0) setCues(layer.id, parsed, known ? { lang: known } : undefined);
      else addCaptionTrack(f.name.replace(/\.[^.]+$/, ""), parsed, known);
      count++;
    }
    if (count) setMsg(`Imported ${count} file${count === 1 ? "" : "s"}.`);
    if (input.current) input.current.value = "";
  };
  const exportOf = (name: string, lang: string | undefined, cs: Cue[]) => {
    const f = CUE_FORMATS.find((x) => x.id === format)!;
    downloadBlob(new Blob([serializeCues(format, cs, { lang: lang ?? "en", fps: project.fps, width: size.w, height: size.h })], { type: f.mime }), `${safeName(name)}${lang ? `.${lang}` : ""}.${f.ext}`);
  };
  const exportAll = () => project.layers.forEach((l) => { const cs = linesToCues(linesOfLayer(project, l.id)); if (cs.length) exportOf(l.name, l.lang, cs); });
  return (
    <Card title="Import and export captions" hint="SRT, WebVTT, LRC, ASS and iTT. Timing is kept exactly; word timing is kept in LRC and ASS.">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-400">
        <input ref={input} type="file" multiple accept=".srt,.vtt,.lrc,.ass,.ssa,.itt,.ttml,.dfxp,.xml,text/plain" className="hidden" onChange={(e) => void importFiles(e.target.files)} />
        <button className={btn} onClick={() => input.current?.click()}>Import files...</button>
        <select className="field !w-auto !py-0.5" value={into} onChange={(e) => setInto(e.target.value as "new" | "replace")} aria-label="Where imported captions go">
          <option value="new">as new tracks</option>
          <option value="replace">replacing "{layer.name}"</option>
        </select>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-400">
        <select className="field !w-auto !py-0.5" value={format} onChange={(e) => setFormat(e.target.value as CueFormat)} aria-label="Caption file format">
          {CUE_FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
        <button className={btn} disabled={!cues.length} onClick={() => exportOf(layer.name, layer.lang, cues)}>Export "{layer.name}"</button>
        <button className={btn} disabled={project.layers.length < 2} onClick={exportAll}>Export all tracks</button>
      </div>
      {msg && <p className="text-[11px] text-gray-400" role="status">{msg}</p>}
    </Card>
  );
}

void applyCutsToCues;
