import { useMacros } from "../store/macros";

/** Shown while a macro is being recorded, so it is never recording by accident. */
export default function MacroPill() {
  const recording = useMacros((s) => s.recording);
  const steps = useMacros((s) => s.draft.length);
  if (!recording) return null;
  return (
    <div role="status" className="fixed bottom-3 right-3 z-40 flex items-center gap-2 rounded-full border border-red-500/50 bg-bg/95 px-3 py-1.5 text-[12px] text-red-200 shadow-panel">
      <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
      Recording a macro, {steps} step{steps === 1 ? "" : "s"}
      <button className="rounded border border-red-400/50 px-2 py-0.5 hover:bg-red-500/20" onClick={() => useMacros.getState().stop()}>Stop and save</button>
      <button className="px-1 text-gray-400 hover:text-gray-200" onClick={() => useMacros.getState().discard()}>Discard</button>
    </div>
  );
}
