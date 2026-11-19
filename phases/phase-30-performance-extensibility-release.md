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
