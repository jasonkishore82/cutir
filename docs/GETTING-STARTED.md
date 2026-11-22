# Getting started

1. **Import** media with the Import button or by dropping files on the library.
2. **Edit** on the Edit page: drag media to the timeline, B for the blade, Delete to remove, Ctrl+Z to undo. Press **Ctrl+K** to find any command.
3. **Colour, audio and Deliver** are the other pages (Pages menu, or the palette).
4. **Export** from Deliver: pick a preset and add it to the queue.

## Keyboard map

Open the command palette (Ctrl+K) and search "shortcuts", or open Settings > Shortcuts to see, rebind, import and export every key.

## Coming from another editor

| You know | In Cutir |
| --- | --- |
| Resolve pages (Cut, Edit, Color, Fairlight, Deliver) | the Pages menu, with the same names |
| Premiere sequences | timelines; nested timelines work as nested sequences |
| Premiere Lumetri | the Colour page: grade, curves, LUTs, scopes |
| Final Cut compound clips | nested timelines |
| Final Cut magnetic timeline | not modelled; tracks are ordinary, use ripple edit |
| Round trip to another editor | export OTIO, EDL or FCPXML from Settings > Project data |
| Resolve scripting | the scripting console, see [SCRIPTING.md](SCRIPTING.md) |

## Troubleshooting

- **Preview is jerky.** Create proxies in the Media library, and leave "Lower the preview quality when playback falls behind" on.
- **Effects look wrong, or the browser reports graphics problems.** Turn off "Use the graphics card for effects" in Settings > Plugins and system.
- **Media is missing after reopening.** Use Relink in the library. Media imported through interchange files is matched by name.
- **The project did not open after a crash.** Cutir keeps a second copy and uses it when the main one is damaged, and a notice says so. Older states are under Settings > Project data > Versions.
- **Reporting a bug.** Turn on the local error log, reproduce the problem and save a diagnostic bundle. Nothing is sent anywhere; attach the file yourself.

More: [PLUGINS.md](PLUGINS.md), [SCRIPTING.md](SCRIPTING.md), [COMPATIBILITY.md](COMPATIBILITY.md).
