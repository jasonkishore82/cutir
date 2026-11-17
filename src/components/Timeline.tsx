import { useProject } from "../store/project";

/** Phase 1 placeholder: lists lines. Waveform, blocks and tap-sync arrive in Phase 3. */
export default function Timeline() {
  const lines = useProject((s) => s.project.lines);
  const selected = useProject((s) => s.selectedLineId);
  const select = useProject((s) => s.select);

  return (
    <div className="h-full flex flex-col">
      <div className="h-8 shrink-0 flex items-center px-3 text-xs text-gray-500 border-b border-edge">
        Timeline: waveform and tap-sync in Phase 3
      </div>
      <div className="flex-1 overflow-auto p-2 space-y-1">
        {lines.length === 0 && <p className="text-xs text-gray-600">Add lyrics in the left panel.</p>}
        {lines.map((l, i) => (
          <button
            key={l.id}
            onClick={() => select(l.id)}
            className={`w-full text-left text-xs px-2 py-1 rounded border truncate ${
              selected === l.id ? "border-accent text-accent" : "border-edge hover:bg-edge"
            }`}
          >
            {i + 1} | {l.start.toFixed(2)}-{l.end.toFixed(2)} | {l.text}
          </button>
        ))}
      </div>
    </div>
  );
}
