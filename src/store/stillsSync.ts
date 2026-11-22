import { useLibrary } from "./library";
import { loadStills, saveStills, useStills } from "../lib/stills";

/**
 * Keeps the stills gallery with the project (phase 20): they are loaded when a project opens and saved when they
 * change, under the project's own key (so they stay out of the project file, versions and sync). Returns a stop function.
 */
export function startStillsPersistence(): () => void {
  let pid: string | null = null;
  const open = (id: string | null) => {
    pid = id;
    useStills.setState({ stills: id ? loadStills(id) : [], compare: { id: null, mode: "off", pos: 0.5 } });
  };
  open(useLibrary.getState().currentId);
  const offLib = useLibrary.subscribe((s, prev) => {
    if (s.currentId !== prev.currentId) open(s.currentId);
  });
  const offStills = useStills.subscribe((s, prev) => {
    if (s.stills === prev.stills || !pid) return;
    const kept = saveStills(pid, s.stills);
    if (kept.length !== s.stills.length) useStills.setState({ stills: kept });
  });
  return () => (offLib(), offStills());
}
