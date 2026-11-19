import { useEffect, useState } from "react";

/** Waiting indicator for a model reply: a small spinner, the elapsed time and the token count. */
export default function Thinking({ tokens = 0 }: { tokens?: number }) {
  const [secs, setSecs] = useState(0);

  useEffect(() => {
    const t0 = Date.now();
    const id = setInterval(() => setSecs(Math.floor((Date.now() - t0) / 1000)), 500);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex items-center gap-2 text-xs text-gray-400" role="status" aria-live="polite">
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/15 border-t-accent" aria-hidden />
      <span>Working</span>
      <span className="tabular-nums text-gray-500">{secs}s</span>
      {tokens > 0 && <span className="tabular-nums text-gray-500">{tokens} tokens</span>}
    </div>
  );
}
