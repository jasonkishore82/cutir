import { useEffect, useState } from "react";
import { getTime } from "../lib/transport";

/** The playhead time, refreshed every animation frame while it changes. */
export function usePlayhead(): number {
  const [t, setT] = useState(getTime);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      setT((prev) => {
        const now = getTime();
        return Math.abs(now - prev) > 1e-4 ? now : prev;
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return t;
}
