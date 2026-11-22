# Scripting

**Settings > Plugins and system > Scripting console** runs a script against the open project. A script is the body of an async function with two names in scope, `cutir` and `console`. It runs in a worker, stops after 15 seconds or 2,000 calls, and every edit is one undo step.

```js
const clips = await cutir.clips();
const long = clips.filter((c) => c.duration > 10);
for (const c of long) await cutir.tool("cut_at", { time: c.start + 5, clips: [c.id] });
return `${long.length} long clips split`;
```

Return a value to show it in the output. `console.log` writes to the output too. Use `cutir.tools()` to see the exact tool names and arguments.

## The API

| Call | Gives |
| --- | --- |
| `cutir.project()` | size, frame rate, timelines (id, name, clip and track counts), media count |
| `cutir.clips()` | clips of the active timeline: id, name, track, start, duration, speed, enabled, kind |
| `cutir.tools()` | every tool as `{ name, signature }`, the same ones the AI assistant has |
| `cutir.tool(name, args)` | run one tool. Arguments are validated, and a bad call throws with the reason. Returns the summary |
| `cutir.commands()` | the commands a script may run: pages, view, tools, playback |
| `cutir.run(id)` | run one of them, for example `"view.fullscreen"` |
| `cutir.log(text)` | write to the output |
| `cutir.sleep(ms)` | wait, up to 5 seconds |

Editing commands from the palette are not exposed. Use `cutir.tool`, which validates and keeps undo working.

## Plugins

A plugin can ship scripts as palette commands; see [PLUGINS.md](PLUGINS.md).
