import { useCaptionPrefs } from "../store/captions";
import { safeRects, SAFE_LABEL } from "../lib/captions/presets";

/** The action-safe and title-safe rectangles and the caption width over the viewer, when switched on in the Captions panel. */
export default function SafeAreaOverlay() {
  const show = useCaptionPrefs((s) => s.showSafe);
  const safe = useCaptionPrefs((s) => s.safe);
  if (!show) return null;
  const r = safeRects(safe);
  const box = (b: { x: number; y: number; w: number; h: number }) => ({ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` });
  return (
    <div className="pointer-events-none absolute inset-0 z-10" aria-hidden>
      <div className="absolute border border-dashed border-yellow-300/70" style={box(r.action)} />
      <div className="absolute border border-dashed border-cyan-300/70" style={box(r.title)} />
      <div className="absolute border border-dotted border-pink-300/70" style={box(r.caption)} />
      <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[9px] text-yellow-200">Action safe</span>
      <span className="absolute left-1 top-4 rounded bg-black/60 px-1 text-[9px] text-cyan-200">Title safe</span>
      <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1 text-[9px] text-pink-200">Captions: {SAFE_LABEL[safe]}</span>
    </div>
  );
}
