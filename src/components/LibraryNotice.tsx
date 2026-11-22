import { useLibrary } from "../store/library";

/** A message about the project that was just opened: a recovery, or a save that could not be read (phase 29). */
export default function LibraryNotice() {
  const notice = useLibrary((s) => s.notice);
  if (!notice) return null;
  return (
    <div role="alert" className="fixed bottom-4 left-1/2 z-50 flex max-w-xl -translate-x-1/2 items-start gap-3 rounded-lg border border-yellow-700/60 bg-panel px-4 py-3 text-[13px] text-yellow-100 shadow-xl">
      <span>{notice}</span>
      <button className="shrink-0 text-xs text-gray-400 underline hover:text-white" onClick={() => useLibrary.getState().dismissNotice()}>Dismiss</button>
    </div>
  );
}
