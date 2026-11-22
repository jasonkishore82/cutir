import type { RawCall } from "../tools/index";

/**
 * Safety for AI edits (phase 28). Every AI turn is one undo step already (applyCalls). On top of that, calls that
 * remove or overwrite work are held until the user says yes. Pure so it can be tested; the chat shows the question.
 */

export type Held = { tool: string; reason: string };

const argsOf = (c: RawCall): Record<string, unknown> => {
  let a = c.args;
  if (typeof a === "string") {
    try {
      a = JSON.parse(a);
    } catch {
      return {};
    }
  }
  return a && typeof a === "object" ? (a as Record<string, unknown>) : {};
};

const count = (v: unknown) => (Array.isArray(v) ? v.length : v ? 1 : 0);

/** Why a call needs a yes first, or null when it is safe to run at once. */
export function holdReason(c: RawCall): string | null {
  const a = argsOf(c);
  switch (c.tool) {
    case "delete_clips": {
      const n = count(a.clips);
      return `Delete ${n || "the"} clip${n === 1 ? "" : "s"}${a.ripple ? " and close the gap" : ""}`;
    }
    case "delete_line":
      return `Delete lyric line ${a.index ?? ""}`.trim();
    case "delete_layer":
      return `Delete the layer ${typeof a.layer === "string" ? `"${a.layer}"` : ""}`.trim();
    case "remove_fillers":
      return "Cut filler words and pauses out of the video, the sound and the captions";
    case "remove_silences":
      return "Cut the pauses out of the video and the sound";
    case "export_video":
      return "Export, which can overwrite a file with the same name";
    default:
      return null;
  }
}

/** The calls that need a yes, with the reason for each. */
export function heldCalls(calls: RawCall[]): Held[] {
  const out: Held[] = [];
  for (const c of calls) {
    const r = holdReason(c);
    if (r) out.push({ tool: c.tool, reason: r });
  }
  return out;
}

/** The sentence shown with Apply and Cancel. */
export function askText(held: Held[]): string {
  if (!held.length) return "";
  const list = held.map((h) => h.reason).join("; ");
  return `Before I do this: ${list}. Apply it? You can undo it afterwards with Ctrl+Z.`;
}
