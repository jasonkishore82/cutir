import type { DeliverPreset, SourceChoice } from "./presets";
import type { Verdict } from "./verify";

/**
 * Phase 26: the render queue's state machine. Pure functions over a list of jobs, so ordering, retry and recovery
 * after a reload are tested without a browser. The runner in store/deliver.ts calls these.
 */

export type JobStatus = "queued" | "paused" | "running" | "done" | "failed" | "cancelled" | "interrupted";

export type Job = {
  id: string;
  /** Shown in the list: timeline name, preset name and range. */
  name: string;
  preset: DeliverPreset;
  timelineId: string;
  timelineName: string;
  start: number;
  end: number;
  source: SourceChoice;
  status: JobStatus;
  progress: number;
  stage: string;
  error?: string;
  fileName?: string;
  bytes?: number;
  verdict?: Verdict;
  /** True while the finished file is still held in memory (it is lost on reload; the job can be re-rendered). */
  hasFile?: boolean;
  attempts: number;
  createdAt: number;
};

export const isActive = (j: Job) => j.status === "queued" || j.status === "running" || j.status === "paused";
export const isFinished = (j: Job) => j.status === "done" || j.status === "failed" || j.status === "cancelled" || j.status === "interrupted";

export function enqueue(jobs: Job[], job: Job): Job[] {
  return [...jobs, job];
}

/** The next job to start: the first queued one. Nothing starts while the queue is held or a job is already running. */
export function nextRunnable(jobs: Job[], held: boolean): Job | undefined {
  if (held || jobs.some((j) => j.status === "running")) return undefined;
  return jobs.find((j) => j.status === "queued");
}

/** Move a waiting job up or down among the waiting jobs. Running and finished jobs keep their places. */
export function move(jobs: Job[], id: string, dir: -1 | 1): Job[] {
  const waiting = (j: Job) => j.status === "queued" || j.status === "paused";
  const i = jobs.findIndex((j) => j.id === id);
  if (i < 0 || !waiting(jobs[i])) return jobs;
  let k = i + dir;
  while (k >= 0 && k < jobs.length && !waiting(jobs[k])) k += dir;
  if (k < 0 || k >= jobs.length) return jobs;
  const out = jobs.slice();
  [out[i], out[k]] = [out[k], out[i]];
  return out;
}

const patch = (jobs: Job[], id: string, f: (j: Job) => Job): Job[] => jobs.map((j) => (j.id === id ? f(j) : j));

/** Hold one waiting job (it is skipped) or let it go again. */
export const setHold = (jobs: Job[], id: string, hold: boolean): Job[] =>
  patch(jobs, id, (j) => (hold && j.status === "queued" ? { ...j, status: "paused" } : !hold && j.status === "paused" ? { ...j, status: "queued" } : j));

/** Cancel a waiting job at once. A running job is cancelled by the runner, which then reports it with `finish`. */
export const cancelWaiting = (jobs: Job[], id: string): Job[] =>
  patch(jobs, id, (j) => (j.status === "queued" || j.status === "paused" ? { ...j, status: "cancelled", stage: "Cancelled" } : j));

/** Put a failed, cancelled or interrupted job back in the queue. Nothing else changes. */
export const retry = (jobs: Job[], id: string): Job[] =>
  patch(jobs, id, (j) =>
    j.status === "failed" || j.status === "cancelled" || j.status === "interrupted" || j.status === "done"
      ? { ...j, status: "queued", progress: 0, stage: "Waiting", error: undefined, verdict: undefined, hasFile: false, fileName: undefined, bytes: undefined }
      : j
  );

export const start = (jobs: Job[], id: string): Job[] =>
  patch(jobs, id, (j) => ({ ...j, status: "running", progress: 0, stage: "Starting", error: undefined, attempts: j.attempts + 1 }));

export const progress = (jobs: Job[], id: string, fraction: number, stage: string): Job[] =>
  patch(jobs, id, (j) => (j.status === "running" ? { ...j, progress: Math.max(0, Math.min(1, fraction)), stage } : j));

export type Outcome = { kind: "done"; fileName: string; bytes: number; verdict?: Verdict } | { kind: "failed"; error: string } | { kind: "cancelled" };

/** Record how a running job ended. A failure never touches the other jobs. */
export function finish(jobs: Job[], id: string, o: Outcome): Job[] {
  return patch(jobs, id, (j) => {
    if (o.kind === "cancelled") return { ...j, status: "cancelled", stage: "Cancelled", hasFile: false };
    if (o.kind === "failed") return { ...j, status: "failed", stage: "Failed", error: o.error, hasFile: false };
    const bad = o.verdict && !o.verdict.ok;
    return { ...j, status: "done", progress: 1, stage: bad ? "Finished, check failed" : "Done", fileName: o.fileName, bytes: o.bytes, verdict: o.verdict, hasFile: true, error: bad ? "The finished file did not pass verification." : undefined };
  });
}

export const remove = (jobs: Job[], id: string): Job[] => jobs.filter((j) => j.id !== id || j.status === "running");
export const clearFinished = (jobs: Job[]): Job[] => jobs.filter((j) => !isFinished(j));

/**
 * What a page reload leaves: a job that was running was cut off, and no finished file survives in memory. Queued jobs
 * are still waiting. Everything keeps its place.
 */
export function recover(jobs: Job[]): Job[] {
  return jobs.map((j) =>
    j.status === "running"
      ? { ...j, status: "interrupted", stage: "Interrupted by a reload", progress: 0 }
      : j.status === "done"
        ? { ...j, hasFile: false }
        : j
  );
}

export const summary = (jobs: Job[]) => ({
  waiting: jobs.filter((j) => j.status === "queued" || j.status === "paused").length,
  running: jobs.filter((j) => j.status === "running").length,
  done: jobs.filter((j) => j.status === "done").length,
  failed: jobs.filter((j) => j.status === "failed" || j.status === "interrupted").length,
});

/** Overall progress of the jobs still to do, 0 to 1. */
export function overall(jobs: Job[]): number {
  const live = jobs.filter(isActive);
  if (!live.length) return 1;
  return live.reduce((a, j) => a + (j.status === "running" ? j.progress : 0), 0) / live.length;
}
