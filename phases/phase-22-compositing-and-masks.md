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
