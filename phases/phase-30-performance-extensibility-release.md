# Phase 30: Performance, Extensibility and Release

Reference: Final hardening so the editor is fast, testable, extensible and ready to ship.

## Performance
- Move decoding, thumbnails, waveforms, proxies, tracking and export into workers; main thread only draws UI
- GPU memory budget and texture pooling; automatic quality drop when playback falls behind
- Benchmarks in CI for timeline scroll, playback, scrub, export speed and memory on reference projects

## Extensibility
- Plugin API for effects, transitions, generators, export presets, AI tools and panels, with a manifest, permissions and sandboxed workers
- Scripting console and a documented command API for automation, in the style of Resolve's scripting interface
- Developer documentation with examples and a starter template

## Quality
- Unit, integration and Playwright end to end tests for edit operations, import, playback and export
- Visual regression tests on rendered frames; golden files for exports
- Error reporting that is opt in and local first; a crash-safe diagnostic bundle the user can attach to a bug report

## Distribution
- Installable PWA with offline support and update prompts
- Optional desktop wrapper for native file access and codecs
- Settings for hardware acceleration, memory limits and cache location
- Docs site: getting started, keyboard map, workflows from Resolve, Premiere and Final Cut, troubleshooting

## Compatibility matrix
- Documented browser support and feature fallbacks (WebGPU, WebCodecs, File System Access), with a start-up capability check and a clear message for missing features

## Done when
- Reference projects meet the performance targets on the minimum supported machine
- A third-party effect can be installed without changing core code
- A release candidate passes the full test suite and a manual smoke test on all supported browsers

## Status

Built and tested in node (`tests/system.test.ts`, `tests/perf.test.ts`); not yet run in a real browser or on the minimum supported machine, so the phase is marked partial.

**Extensibility**
- Plugins are one JSON file (`src/lib/plugins/`, `docs/PLUGINS.md`): a manifest with an API version and permissions, validated with every problem listed. A plugin can add effects (a GLSL pass plus parameters, so no plugin code runs on the page), delivery presets and script commands. Installing registers them in the existing effect registry, delivery presets and command palette; removing undoes it. A third-party effect needs no change to core code.
- Scripting (`src/lib/scripting/`, `docs/SCRIPTING.md`): a console in Settings and plugin scripts run in a worker through a `cutir` API (project, clips, tools, commands). Every call goes through one checked door; edits use the assistant's validated, undoable tools; scripts stop after 15 seconds or 2,000 calls.
- Docs: getting started, a Resolve/Premiere/Final Cut table, troubleshooting, plugin and scripting guides, a starter plugin.

**Performance**
- Automatic quality (`src/lib/system/governor.ts`): while playing, the preview is drawn at 75%, 50% or 35% when frames come out below 80% of the project rate, and returns slowly. A switch turns it off. A second switch turns off the GPU path for effects.
- Benchmarks (`tests/perf.test.ts`) on reference projects of 400 and 3,000 clips with generous budgets, run by `npm test` and CI (`.github/workflows/ci.yml`).

**Quality**
- Capability check at start (`src/lib/system/capabilities.ts`, `docs/COMPATIBILITY.md`): required, recommended and optional features, a message for what is missing and what the fallback is, and the same list in Settings.
- Opt-in local error log and a diagnostic bundle (`src/lib/system/diagnostics.ts`): written at once, paths, links, emails and file names removed, no project content, never sent anywhere.

**Distribution**
- Installable PWA (`public/manifest.webmanifest`, `public/sw.js`): works offline once loaded, and a new version waits behind an "Update now" button.

**Not done, or different from the plan**
- Moving decoding, thumbnails, waveforms and export fully into workers, a GPU memory budget and texture pooling beyond the existing layer pool: the code already uses workers for probing, proxies, beats and sync, but not for every task in the list.
- Plugins cannot add transitions, generators, AI tools or panels yet, and effects have no CPU version (they pass through without WebGL 2). Plugin scripts run in a worker with the network APIs removed; that is not a hard sandbox against hostile code.
- Playwright end to end tests, visual regression and golden export files; the benchmarks run on logic, not on rendering, playback or export speed in a browser.
- The desktop wrapper, a memory limit and a cache location setting.
- The manual smoke test in `docs/COMPATIBILITY.md` has not been run on all browsers.
