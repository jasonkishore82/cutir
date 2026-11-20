import { Card, Slider } from "./ui";
import { useProject } from "../store/project";
import { activeTimeline } from "../model/convert";
import { IDENTITY_TRANSFORM, type BlendMode, type ClipTransform, type TrackMatte } from "../model/types";
import { editTimeline, useTimelineUi } from "../timeline/ui";

const BLENDS: BlendMode[] = ["normal", "add", "multiply", "screen", "overlay", "softlight", "hardlight", "darken", "lighten", "dodge", "burn", "difference", "exclusion"];

/** Placement of the selected timeline clip (video or image), or the volume of an audio clip. */
export default function ClipCard() {
  const selected = useTimelineUi((s) => s.selected);
  const doc = useProject((s) => s.doc);
  const tl = activeTimeline(doc);
  const clips = selected.map((id) => tl.clips.find((c) => c.id === id)).filter((c): c is NonNullable<typeof c> => !!c && !c.fill && !!c.mediaId);
  if (!clips.length) return null;
  const kindOf = (id?: string) => doc.media.find((m) => m.id === id)?.kind;
  const visual = clips.filter((c) => kindOf(c.mediaId) === "video" || kindOf(c.mediaId) === "image");
  const sound = clips.filter((c) => kindOf(c.mediaId) === "audio");
  const first = visual[0];
  const tf: ClipTransform = { ...IDENTITY_TRANSFORM, ...(first?.transform ?? {}) };
  const ids = new Set(visual.map((c) => c.id));
  const setTf = (patch: Partial<ClipTransform>, key: string) =>
    editTimeline((t) => ({ ...t, clips: t.clips.map((c) => (ids.has(c.id) ? { ...c, transform: { ...(c.transform ?? {}), ...patch } } : c)) }), `clip-tf:${[...ids].join(",")}:${key}`);
  const soundIds = new Set(sound.map((c) => c.id));
  const vol = sound[0]?.volume ?? 1;

  return (
    <Card title={clips.length > 1 ? `${clips.length} clips` : "Clip"} hint="The selected timeline clip. Several selected clips change together.">
      {first && (
        <>
          <Slider label="Horizontal" value={Math.round(tf.x * 100)} min={-50} max={150} unit="%" onChange={(v) => setTf({ x: v / 100 }, "x")} />
          <Slider label="Vertical" value={Math.round(tf.y * 100)} min={-50} max={150} unit="%" onChange={(v) => setTf({ y: v / 100 }, "y")} />
          <Slider label="Size" value={Math.round(tf.scale * 100)} min={5} max={400} unit="%" onChange={(v) => setTf({ scale: v / 100 }, "s")} />
          <Slider label="Rotation" value={tf.rotation} min={-180} max={180} unit=" deg" onChange={(v) => setTf({ rotation: v }, "r")} />
          <Slider label="Opacity" value={Math.round(tf.opacity * 100)} min={0} max={100} unit="%" onChange={(v) => setTf({ opacity: v / 100 }, "o")} />
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="label">Blend</span>
              <select className="field" value={tf.blend} onChange={(e) => setTf({ blend: e.target.value as BlendMode }, "b")}>
                {BLENDS.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="label">Fit</span>
              <select className="field" value={tf.fit} onChange={(e) => setTf({ fit: e.target.value as ClipTransform["fit"] }, "f")}>
                <option value="contain">Fit inside</option>
                <option value="cover">Fill (crop)</option>
                <option value="fill">Stretch</option>
              </select>
            </label>
          </div>
          {visual.length === 1 && (
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="label">Matte from</span>
                <select
                  className="field"
                  value={first.matte?.clipId ?? ""}
                  onChange={(e) => editTimeline((t) => ({ ...t, clips: t.clips.map((c) => (c.id === first.id ? { ...c, matte: e.target.value ? { clipId: e.target.value, mode: first.matte?.mode ?? "alpha" } : undefined } : c)) }))}
                >
                  <option value="">none</option>
                  {tl.clips.filter((c) => c.id !== first.id && !c.fill && tl.tracks.find((t) => t.id === c.trackId)?.kind === "video").map((c) => (
                    <option key={c.id} value={c.id}>{c.name ?? doc.media.find((m) => m.id === c.mediaId)?.name ?? c.generator?.type ?? c.id}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="label">Matte type</span>
                <select
                  className="field"
                  disabled={!first.matte}
                  value={first.matte?.mode ?? "alpha"}
                  onChange={(e) => editTimeline((t) => ({ ...t, clips: t.clips.map((c) => (c.id === first.id && c.matte ? { ...c, matte: { ...c.matte, mode: e.target.value as TrackMatte["mode"] } } : c)) }))}
                >
                  <option value="alpha">Alpha</option>
                  <option value="alpha-inverted">Alpha, inverted</option>
                  <option value="luma">Luma</option>
                  <option value="luma-inverted">Luma, inverted</option>
                </select>
              </label>
            </div>
          )}
          <button
            className="w-full rounded-lg border border-edge px-3 py-1.5 text-left text-[12px] text-gray-300 hover:bg-raised"
            onClick={() => editTimeline((t) => ({ ...t, clips: t.clips.map((c) => (ids.has(c.id) ? { ...c, transform: undefined } : c)) }))}
          >
            Reset placement
          </button>
        </>
      )}
      {sound.length > 0 && (
        <Slider
          label="Volume"
          value={Math.round(vol * 100)}
          min={0}
          max={200}
          unit="%"
          onChange={(v) => editTimeline((t) => ({ ...t, clips: t.clips.map((c) => (soundIds.has(c.id) ? { ...c, volume: v / 100 } : c)) }), `clip-vol:${[...soundIds].join(",")}`)}
        />
      )}
    </Card>
  );
}
