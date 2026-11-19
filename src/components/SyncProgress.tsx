import { useEffect, useRef, useState } from "react";
import { cancelAlignment, useSyncJob } from "../lib/autosync";
import type { AlignProgress } from "../lib/aligner";

const LABELS: Record<AlignProgress["stage"], string> = {
  uploading: "Uploading song",
  separating: "Separating vocals",
  loading: "Loading model (the first run downloads it)",
  aligning: "Aligning lyrics",
};

/** Where each stage sits on the bar. Vocal separation is the long stage when it is on. */
function stageRange(stage: AlignProgress["stage"], separate: boolean): [number, number] {
  if (separate) {
    return { uploading: [0, 0.03], separating: [0.03, 0.6], loading: [0.6, 0.68], aligning: [0.68, 0.97] }[stage] as [number, number];
  }
  return { uploading: [0, 0.05], separating: [0.05, 0.05], loading: [0.05, 0.2], aligning: [0.2, 0.97] }[stage] as [number, number];
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** Animated progress bar for the shared auto-sync job. Renders nothing while idle. */
export default function SyncProgress() {
  const { phase, stage, pct, separate } = useSyncJob();
  const [shown, setShown] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const shownRef = useRef(0);
  const live = useRef({ stage, pct, separate });
  live.current = { stage, pct, separate };

  // restart the bar whenever a new job begins
  useEffect(() => {
    if (phase === "running") {
      shownRef.current = 0;
      setShown(0);
      setElapsed(0);
    }
  }, [phase === "running"]); // eslint-disable-line react-hooks/exhaustive-deps

  // ease toward the stage target; creep slowly while a stage cannot be measured
  useEffect(() => {
    if (phase !== "running") return;
    const t0 = Date.now();
    const id = setInterval(() => {
      const { stage, pct, separate } = live.current;
      const [lo, hi] = stageRange(stage, separate);
      const measured = pct !== undefined;
      const target = measured ? lo + (hi - lo) * pct! : lo + (hi - lo) * 0.92;
      const rate = measured ? 0.25 : shownRef.current < lo ? 0.15 : 0.012;
      shownRef.current = Math.max(shownRef.current, shownRef.current + (target - shownRef.current) * rate);
      setShown(shownRef.current);
      setElapsed(Math.floor((Date.now() - t0) / 1000));
    }, 100);
    return () => clearInterval(id);
  }, [phase]);

  if (phase === "idle") return null;
  const value = phase === "done" ? 1 : shown;
  const running = phase === "running";

  return (
    <div className="space-y-1.5" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
      <div className="flex items-center justify-between text-[11px] text-gray-400">
        <span className="truncate">{running ? LABELS[stage] : "Done"}</span>
        <span className="ml-2 shrink-0 tabular-nums">
          {Math.round(value * 100)}%{running ? `, ${mmss(elapsed)}` : ""}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full border border-edge bg-bg">
        <div
          className={`h-full rounded-full bg-accent ${running ? "progress-stripes" : ""}`}
          style={{ width: `${Math.max(2, value * 100)}%`, transition: "width 120ms linear" }}
        />
      </div>
      {running && (
        <button className="rounded border border-red-700 px-2 py-1.5 text-xs text-red-300 hover:bg-edge" onClick={cancelAlignment}>
          Cancel
        </button>
      )}
    </div>
  );
}
