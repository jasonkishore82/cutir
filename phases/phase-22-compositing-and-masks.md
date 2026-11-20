# Phase 22: Compositing, Masks and Node Graph

Reference: Resolve's Fusion page is a node-based compositor. Cutir can start with a per-clip node graph and masks, which covers most motion graphics work.

## Node graph (`lib/graph/`)
- Per clip graph of nodes: media in, effects, merge, transform, mask, text, generator, media out
- Graph editor with pan, zoom, drag to connect, group, bypass and preview from any node
- The simple effect stack from phase 17 is the default view of the same graph

## Blend and track matte
- Blend modes: normal, add, multiply, screen, overlay, soft light, difference, darken, lighten, colour dodge and burn
- Alpha, luma and inverted track mattes; use another clip or a shape as the matte

## Masks
- Bezier, rectangle, ellipse and polygon masks with feather, expansion and inversion
- Masks are keyframable and can be linked to a tracker

## Tracking and stabilisation
- Point tracker and planar tracker running in a worker; attach text or a mask to a tracked point
- Stabilise with smoothing strength and crop control

## Green screen
- Keyer with spill suppression, edge shrink and softness, and a matte view

## Done when
- A title can be pinned to a moving object with a tracker
- A green screen clip can be keyed and composited over a background
- Graph and stack views stay in sync

## Status (partly built)
Built (`src/lib/graph/`, `src/lib/track/`, `src/lib/masks.ts`, `src/render/compositor.ts`, tests in `tests/compositing.test.ts`):
- Node graph per clip (`Clip.graph`): input, effect, merge (any blend mode, opacity), generator and output nodes; graph editor card with pan, zoom, drag, click-to-connect, bypass, delete, and preview from any node; loops are refused; a node read twice runs once. `stackToGraph` and `graphToStack` keep the phase 17 effect stack as the default view: a plain chain converts back to a stack, a branching graph replaces it for that clip. Not built: grouping nodes, text nodes, mask nodes (masks are an effect node), transform nodes (the Transform effect is one).
- Blend modes: normal, add, multiply, screen, overlay, soft light, hard light, darken, lighten, colour dodge, colour burn, difference, exclusion (clip blend, merge nodes, chat tool).
- Track mattes: a clip can use another video clip as alpha, luma, inverted alpha or inverted luma matte (Clip card, `set_matte`); the matte clip is not drawn itself. A rectangle or shape matte is made by putting a shape generator clip on a track.
- Masks: the Mask effect now has rectangle, ellipse, polygon and bezier (smooth) shapes, a point editor, grow or shrink, feather, invert, offsets that keyframe, and "Follow this clip's tracker".
- Tracking: a block-matching point tracker (sub-pixel, drift-corrected template, lost-match detection), run from the Tracking card on the exact frames the export uses. Trackers are stored on the clip; any clip can be pinned to a tracker (title on a moving object), and a clip can be stabilised from its own tracker with smoothing and extra crop; the zoom that hides the borders is computed from the path.
- Green screen: the keyer gained edge shrink, blue-screen spill suppression and a matte view (GPU and CPU paths).

Not built yet: a planar tracker (point tracking only); tracking runs on the main thread in small steps rather than in a worker; masks cannot be keyframed point by point (offsets, grow and feather are keyframable); the mask editor edits a path on a small preview, not on the viewer; rotation and scale from a tracker (position only); stabilisation needs one tracked point, so it does not remove rotation.
