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

## Status (done)
Built (`src/lib/graph/`, `src/lib/track/`, `src/lib/masks.ts`, `src/render/compositor.ts`, tests in `tests/compositing.test.ts`):
- Node graph per clip (`Clip.graph`): input, effect, merge (any blend mode, opacity), generator and output nodes; graph editor card with pan, zoom, drag, click-to-connect, bypass, delete, and preview from any node; loops are refused; a node read twice runs once. `stackToGraph` and `graphToStack` keep the phase 17 effect stack as the default view: a plain chain converts back to a stack, a branching graph replaces it for that clip. (Grouping and the transform, mask and text nodes: see below.)
- Blend modes: normal, add, multiply, screen, overlay, soft light, hard light, darken, lighten, colour dodge, colour burn, difference, exclusion (clip blend, merge nodes, chat tool).
- Track mattes: a clip can use another video clip as alpha, luma, inverted alpha or inverted luma matte (Clip card, `set_matte`); the matte clip is not drawn itself. A rectangle or shape matte is made by putting a shape generator clip on a track.
- Masks: the Mask effect now has rectangle, ellipse, polygon and bezier (smooth) shapes, a point editor, grow or shrink, feather, invert, offsets that keyframe, and "Follow this clip's tracker".
- Tracking: a block-matching point tracker (sub-pixel, drift-corrected template, lost-match detection), run from the Tracking card on the exact frames the export uses. Trackers are stored on the clip; any clip can be pinned to a tracker (title on a moving object), and a clip can be stabilised from its own tracker with smoothing and extra crop; the zoom that hides the borders is computed from the path.
- Green screen: the keyer gained edge shrink, blue-screen spill suppression and a matte view (GPU and CPU paths).

Also built (the rest of the phase):
- Planar tracker (`src/lib/track/planar.ts`): a flat surface is followed by tracking a grid of points inside a region. Each frame the way the points moved is fitted with a homography (perspective included) with outliers thrown out and refitted, and the centre, rotation and scale of the surface come from it; with two or three good points a similarity is used. Points that disagree (a hand crossing the surface) are dropped and the rest keep tracking. Point confidence is judged against the patch's own contrast, so a blank frame is a lost point. Tested on synthetic textured frames with known motion (centre within about a pixel, rotation within about a degree, scale within 3%).
- Tracking in a worker (`track.worker.ts`, `matcher.ts`, `session.ts`): the page draws each frame and sends the gray pixels; the worker does the block matching, and the next frame is drawn while one is being matched. Without Worker support it runs on the page as before.
- Rotation and scale from a tracker: a pinned clip can turn and grow with a planar tracker (its offset from the tracked point turns and grows too), and stabilisation can also remove the camera's turning, with the zoom needed to hide the corners it uncovers. The Tracking card has "A point" and "A flat surface" modes, with the region shown on the viewer.
- Masks keyframe point by point: the shape's outline is a keyframe value (the keyframe engine gained a "path" kind), blended point by point with the usual easing; "Key the shape here", remove key and clear are on the Mask effect, and with keys an edit writes a key at the playhead. Adding or removing a point drops the keys that cannot blend with it.
- Mask editor on the viewer (`src/components/MaskOverlay.tsx`, `src/lib/maskEdit.ts`): "On viewer" on a Mask effect draws the shape over the picture (including the mask's own offset and the tracker it follows) with a handle per point for polygons and bezier shapes (drag, click to add, double-click to remove) and a centre and four edge handles for rectangles and ellipses.
- Graph nodes: transform (move, scale, turn, fade), mask (the Mask effect's shape, or the alpha of a picture connected to its second input as the matte), text, and groups (select nodes with Shift-click, Group; Ungroup opens it back). A group reads one picture and gives one, so it is refused with the reason when the nodes read from more than one outside node or more than one of them is used outside. Groups nest because a group is a graph of its own.
- Tests: tests/planar.test.ts, tests/graph-mask.test.ts.

Not checked in a real browser (the viewer overlay, the worker round trip with real decoded frames, tracking real footage). Limits: the planar tracker's perspective is used for the fit, but a pinned clip receives position, rotation and scale only (it is not warped into a corner pin); a mask that follows a tracker follows its position, not its rotation or scale; stabilisation turns about the centre of the frame rather than the tracked surface; a group's inside is edited by ungrouping it.
