# Phase 27: Workspaces, Pages, Shortcuts and Command Palette

Reference: Resolve's page bar switches the whole workspace while the project stays the same. Cutir's top bar sections (Media, Lyrics, Style, Motion) grow into proper workspaces.

## Workspaces
- Bottom or top page bar: Media, Cut, Edit, Motion, Color, Audio, Lyrics, Deliver
- Each page is a saved panel layout over the same project and timeline; panels can be docked, tabbed, floated, resized and hidden
- Layout presets and a reset; layouts are saved per user

## Cut page
- A quick page with a source viewer, a two-row timeline, quick export and smart tools for fast assembly

## Shortcuts
- Full shortcut map with defaults close to Resolve and Premiere, rebinding, import and export of keymaps, a cheat sheet overlay
- JKL shuttle, I and O marks, B for blade, V for select, S for snapping

## Command palette
- Ctrl K opens a searchable list of every command, setting and recent project
- Every menu item, tool and AI action is registered as a command once

## Accessibility and UI
- Keyboard access to every panel and menu, visible focus, reduced motion, high contrast theme, scalable UI text
- Touch and pen support for tablets

## Done when
- Switching pages keeps the playhead, selection and undo history
- Every action is reachable from the command palette
- The app is fully operable with the keyboard

## Status

Built: eight pages (Media, Cut, Edit, Motion, Color, Audio, Lyrics, Deliver) on a page bar under the timeline, each with its own saved panel layout (inspector, timeline, AI panel width; show, hide, resize by mouse or keyboard), layout presets, reset, import and export; the Cut page's quick action bar; the Deliver page. One command registry (`src/lib/commands/`) feeds the Ctrl+K palette (commands, pages, settings, one AI action per tool, recent projects), the menus, the cheat sheet (Ctrl+/ or F1) and Settings, Keyboard shortcuts, where keys can be added, removed, reset, filled from a Resolve-like or Premiere-like profile, imported and exported. Defaults: V select, B blade, S snapping, I and O marks, JKL shuttle, Alt+1 to 8 for pages. Accessibility: reduced motion, high contrast, interface text size, visible focus, skip link, keyboard-resizable dividers. Tests in `tests/workspace.test.ts` (including that switching pages leaves the document, undo history and selection untouched).

Not done: free docking, tabbing and floating of panels (panels resize and hide only); the Cut page's two-row timeline and source viewer (it uses the normal timeline at a short height); keys that depend on selection (Delete, nudge, lyric copy and paste, keyframe K) are fixed, not rebindable; most menu items are still declared in the menu bar rather than generated from the registry; touch and pen support is limited to pointer events and larger targets. Not yet checked in a real browser (the browser tool was not connected): type-check, build and unit tests pass.
