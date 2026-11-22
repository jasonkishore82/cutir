/**
 * The scripting API (phase 30), in the style of Resolve's scripting interface. A script is the body of an async
 * function with two names in scope: `cutir` and `console`. Every `cutir.*` call goes to the page through `handleCall`,
 * which is the only door: it checks the method against this list and the arguments' types, so a script can do exactly
 * what the API offers and nothing else. Edits go through the assistant's tools, so they are validated and undoable.
 */

export type ScriptHost = {
  /** Commands scripts may run: pages, view, tools and playback (never editing commands). */
  commands: () => { id: string; title: string; category: string }[];
  run: (id: string) => Promise<boolean>;
  tools: () => { name: string; signature: string }[];
  /** Validate and apply one tool call as one undo step. */
  tool: (name: string, args: unknown) => Promise<{ ok: boolean; summary: string }>;
  project: () => unknown;
  clips: () => unknown[];
  log: (text: string) => void;
};

export const METHODS = ["commands", "run", "tools", "tool", "project", "clips", "log", "sleep"] as const;
export type Method = (typeof METHODS)[number];
export const MAX_CALLS = 2000;

export async function handleCall(host: ScriptHost, method: string, args: unknown[]): Promise<unknown> {
  if (!(METHODS as readonly string[]).includes(method)) throw new Error(`cutir.${method} does not exist. Methods: ${METHODS.join(", ")}`);
  const a = args ?? [];
  switch (method as Method) {
    case "commands":
      return host.commands();
    case "run": {
      if (typeof a[0] !== "string") throw new Error("cutir.run(id) needs a command id (a string)");
      const ok = await host.run(a[0]);
      if (!ok) throw new Error(`the command "${a[0]}" is not available (see cutir.commands())`);
      return true;
    }
    case "tools":
      return host.tools();
    case "tool": {
      if (typeof a[0] !== "string") throw new Error("cutir.tool(name, args) needs a tool name (a string)");
      const r = await host.tool(a[0], a[1] ?? {});
      if (!r.ok) throw new Error(r.summary);
      return r.summary;
    }
    case "project":
      return host.project();
    case "clips":
      return host.clips();
    case "log":
      host.log(String(a[0] ?? "").slice(0, 2000));
      return null;
    case "sleep": {
      const ms = Math.min(5000, Math.max(0, Number(a[0]) || 0));
      await new Promise((r) => setTimeout(r, ms));
      return null;
    }
  }
}
