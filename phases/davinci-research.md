# DaVinci Resolve: how import and editing work

Research notes used to plan phases 11 to 30. Sources are public tutorials and blog posts, not Blackmagic's own manual, so check exact menu names and shortcuts against the official documentation before copying behaviour.

## Structure: seven pages in one project
Resolve is one application with a page per job, switched from a bar along the bottom. The workflow runs left to right.

| Page | Job |
|---|---|
| Media | Import and organise footage |
| Cut | Fast rough assembly |
| Edit | Detailed timeline work |
| Fusion | Visual effects and motion graphics |
| Color | Colour correction and grading |
| Fairlight | Audio mixing and editing |
| Deliver | Export |

The Media Pool is shared by every page: once a clip is in it, any page can use it.

## Import
- The Media page is the main entry point for bringing media in and organising it.
- Clips can be imported from the Media Pool context menu (Import Media) or by dragging files from disk into the Media Pool.
- Import is also available from the Cut and Edit pages, so the user is never forced back to the Media page.

## Editing (Edit page)
- One smart trim tool switches between ripple, roll, slip and slide depending on where the pointer sits.
  - Ripple: trims a clip edge and shifts everything after it.
  - Roll: moves the cut between two clips, so total timeline length does not change.
  - Slip: changes which part of a clip is visible, clip length and position unchanged.
  - Slide: moves a clip along the timeline, neighbours absorb the change, clip length unchanged.
- Dedicated Trim mode and Dynamic Trim mode exist for playback-driven trimming; slip and slide can be toggled with a shortcut.
- Keyframes can be moved, retimed and given ease controls for nearly every parameter.

## Performance: proxies, optimized media, render cache
- Proxy media: lower resolution copies generated from the Media Pool (right-click, Generate Proxy Media). Resolution is chosen in project settings.
- Optimized media: edit-friendly transcodes of heavy source formats, stored in the cache location.
- Render cache: pre-rendered effects so playback stays real time.
- Final render normally uses the original media. A Deliver setting decides whether proxy or optimized media is used instead. Sources disagree on the exact checkbox behaviour, so verify before copying.

## What this means for Cutir
- Add a Media Pool and make it the one place assets live (phase 12).
- Keep pages as workspaces over one shared project, not separate documents (phase 27).
- Build the trim tools as one pointer-aware tool, not five buttons (phase 14).
- Plan for proxies and a cache early, because the browser has less memory and no native codecs to lean on (phase 16).
- Keep export as its own stage with a queue (phase 26).

## Not covered by these sources
Transitions, track-level behaviour, render queue presets, Fusion node internals and the Color page tools were not described in enough detail. Phases 17, 20, 22 and 26 are therefore based on general professional-editor practice and should be checked against the Resolve manual during implementation.

## Sources
- [DaVinci Resolve Interface and Pages](https://2pop.calarts.edu/?p=13141)
- [The Basics of DaVinci Resolve (Adorama)](https://www.adorama.com/alc/the-basics-of-davinci-resolve)
- [Media page overview (CreativeLive)](https://phoenix.creativelive.com/class/davinci-resolve-how-to-use-every-page-casey-faris/lessons/media-page-overview)
- [Edit page basic workflow (CreativeLive)](https://site.creativelive.com/class/davinci-resolve-how-to-use-every-page-casey-faris/lessons/edit-page-basic-workflow)
- [DaVinci Resolve Edit page (Blackmagic Design)](https://blackmagicdesign.com/products/davinciresolve/edit)
- [Dynamic trim tool in Resolve (PremiumBeat)](https://www.premiumbeat.com/blog/dynamic-trim-tool-resolve/)
- [How to use the trim tool in Resolve (Videomaker)](https://www.videomaker.com/how-to/editing/editing-technique/how-to-use-the-trim-tool-in-blackmagic-davinci-resolve/)
- [Resolve proxies (Frame.io workflow guide)](https://workflow.frame.io/guide/resolve-proxies)
- [Using optimized media in Resolve (PremiumBeat)](https://www.premiumbeat.com/blog/using-optimized-media-davinci-resolve/)
- [How to use proxies and optimized media (Vidio)](https://www.vidio.ai/blog/article/how-to-use-proxies-and-optimized-media-in-davinci-resolve)
