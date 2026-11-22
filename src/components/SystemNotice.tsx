import { useState } from "react";
import { useSystem } from "../store/system";

/** Start-up messages (phase 30): a missing browser feature, and a new version waiting to take over. */
export default function SystemNotice() {
  const report = useSystem((s) => s.report);
  const update = useSystem((s) => s.update);
  const [hidden, setHidden] = useState(false);
  const bad = [...report.blocking, ...report.degraded];
  return (
    <>
      {update && (
        <div role="status" className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-lg border border-edge bg-panel px-4 py-3 text-[13px] text-gray-100 shadow-xl">
          <span>A new version of Cutir is ready.</span>
          <button className="rounded-md border border-edge px-2 py-1 text-xs hover:bg-raised" onClick={() => update.apply()}>Update now</button>
        </div>
      )}
      {bad.length > 0 && !hidden && (
        <div role="alert" className={`fixed left-1/2 top-3 z-50 flex max-w-xl -translate-x-1/2 items-start gap-3 rounded-lg border bg-panel px-4 py-3 text-[13px] shadow-xl ${report.ok ? "border-yellow-700/60 text-yellow-100" : "border-red-700/60 text-red-100"}`}>
          <span>
            {report.ok ? "This browser lacks some features: " : "This browser cannot run Cutir: "}
            {bad.map((i) => `${i.name} (${i.without})`).join(" ")}
          </span>
          <button className="shrink-0 text-xs text-gray-400 underline hover:text-white" onClick={() => setHidden(true)}>Dismiss</button>
        </div>
      )}
    </>
  );
}
