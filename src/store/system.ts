import { create } from "zustand";
import { createGovernor } from "../lib/system/governor";
import { check, detect, message, type Report } from "../lib/system/capabilities";
import { addError, buildBundle, type LoggedError } from "../lib/system/diagnostics";
import { setGpuEnabled } from "../lib/effects/gpu";
import { useProject } from "./project";
import { usePlugins } from "./plugins";
import type { UpdateHandle } from "../lib/system/pwa";
import { download } from "../lib/interchange/common";

/** Performance and diagnostics settings (phase 30), kept in this browser only. */

const KEY = "cutir:system";
const ERR_KEY = "cutir:errors";

type Saved = { autoQuality: boolean; gpuEffects: boolean; keepErrors: boolean };
type State = Saved & {
  report: Report;
  /** Preview scale chosen by the quality governor (1 = full). */
  scale: number;
  errors: LoggedError[];
  /** A new app version waiting for the user to accept it. */
  update: UpdateHandle | null;
  governor: ReturnType<typeof createGovernor>;
  set: (patch: Partial<Saved>) => void;
  setScale: (s: number) => void;
  logError: (kind: LoggedError["kind"], message: unknown, stack?: unknown) => void;
  clearErrors: () => void;
  saveBundle: () => void;
  warning: () => string;
};

const DEFAULTS: Saved = { autoQuality: true, gpuEffects: true, keepErrors: false };
const saved = (): Saved => {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return DEFAULTS;
  }
};
const loadErrors = (): LoggedError[] => {
  try {
    const v = JSON.parse(localStorage.getItem(ERR_KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

export const useSystem = create<State>((set, get) => ({
  ...saved(),
  report: check(detect()),
  scale: 1,
  errors: loadErrors(),
  update: null,
  governor: createGovernor(),
  set: (patch) => {
    const { autoQuality, gpuEffects, keepErrors } = { ...get(), ...patch };
    try {
      localStorage.setItem(KEY, JSON.stringify({ autoQuality, gpuEffects, keepErrors }));
    } catch {
      /* ignore */
    }
    setGpuEnabled(gpuEffects);
    if (!autoQuality) get().governor.reset();
    set({ ...patch, ...(autoQuality ? {} : { scale: 1 }) });
  },
  setScale: (scale) => get().scale !== scale && set({ scale }),
  logError: (kind, msg, stack) => {
    if (!get().keepErrors) return; // opt in: with the switch off nothing is recorded
    const errors = addError(get().errors, { kind, message: msg, stack });
    try {
      localStorage.setItem(ERR_KEY, JSON.stringify(errors)); // written at once, so a crash right after still has it
    } catch {
      /* ignore */
    }
    set({ errors });
  },
  clearErrors: () => {
    try {
      localStorage.removeItem(ERR_KEY);
    } catch {
      /* ignore */
    }
    set({ errors: [] });
  },
  warning: () => message(get().report),
  saveBundle: () => {
    const d = useProject.getState().doc;
    const bundle = buildBundle({
      app: { version: "0.1.0" },
      userAgent: navigator.userAgent,
      language: navigator.language,
      capabilities: get().report,
      env: { ...detect(), dpr: window.devicePixelRatio },
      errors: get().errors,
      project: { timelines: d.timelines.length, tracks: d.timelines.reduce((n, t) => n + t.tracks.length, 0), clips: d.timelines.reduce((n, t) => n + t.clips.length, 0), media: d.media.length, durationSeconds: Math.max(0, ...d.timelines.flatMap((t) => t.clips.map((c) => c.start + c.duration))), fps: d.settings.fps, width: d.settings.width, height: d.settings.height },
      perf: { autoQuality: get().autoQuality, scale: get().scale },
      plugins: usePlugins.getState().list.map((p) => ({ id: p.id, version: p.version })),
    });
    download(`cutir-diagnostics-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(bundle, null, 2), "application/json");
  },
}));

/** Catch errors the page would otherwise only print to the console. Records nothing until the user opts in. */
export function installErrorCapture(): () => void {
  const onError = (e: ErrorEvent) => useSystem.getState().logError("error", e.message, e.error?.stack);
  const onRejection = (e: PromiseRejectionEvent) => useSystem.getState().logError("rejection", (e.reason as Error)?.message ?? e.reason, (e.reason as Error)?.stack);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  setGpuEnabled(useSystem.getState().gpuEffects);
  return () => (window.removeEventListener("error", onError), window.removeEventListener("unhandledrejection", onRejection));
}
