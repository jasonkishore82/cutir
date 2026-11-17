import { useProject } from "../store/project";

const RATIOS = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1 } as const;

/** Phase 1 placeholder: letterboxed frame at the chosen aspect. Canvas renderer lands in Phase 2. */
export default function Preview() {
  const aspect = useProject((s) => s.project.aspect);
  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 min-h-0 flex items-center justify-center p-4">
        <div
          className="max-h-full max-w-full border border-edge flex items-center justify-center text-gray-500 text-sm"
          style={{
            aspectRatio: RATIOS[aspect],
            height: aspect === "9:16" ? "100%" : undefined,
            width: aspect === "9:16" ? undefined : "100%",
            background: "linear-gradient(135deg,#1e2a6b,#5b3a8c,#d4687a,#f0a070)",
          }}
        >
          Preview ({aspect}): canvas renderer in Phase 2
        </div>
      </div>
      <div className="h-10 shrink-0 border-t border-edge flex items-center px-3 text-xs text-gray-500">
        Transport controls in Phase 2
      </div>
    </div>
  );
}
