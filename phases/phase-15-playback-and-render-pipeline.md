# Phase 15: Playback Engine and Compositor

Reference: Smooth playback of many layers is what separates an editor from a slideshow. Resolve keeps playback real time with caches and a GPU pipeline.

## Decoding
- Decode video with WebCodecs in workers; one decoder per active clip with look-ahead and frame queues
- Seek by nearest keyframe then decode forward; drop frames when behind, never stall audio
- Image sequences and still images through ImageBitmap

## Compositing
- Renderer uses WebGPU with a WebGL2 fallback; every clip becomes a textured quad with transform, opacity and blend mode
- Frame graph per timestamp: sort active clips by track, apply effects (phase 17), composite into an output texture
- Text and shapes drawn to offscreen canvases and uploaded as textures; the existing `drawFrame` becomes the text layer renderer
- Single code path for viewer and export, as today

## Clock and sync
- Audio clock is the master; video frames are chosen against it
- Scrubbing: show the nearest cached frame immediately, refine when decoding catches up
- Loop, JKL shuttle, slow motion and reverse playback

## Frame cache
- LRU of decoded frames and composited frames with a memory budget
- Memory pressure handling: close VideoFrames promptly, lower the cache on `memory` warnings

## Diagnostics
- Dropped frame counter and playback fps overlay; a debug panel for decoder state

## Done when
- Four video layers with transforms play at 30 fps on a mid-range laptop
- Audio never glitches during scrubbing or seeking
- Viewer and export produce identical frames for the same timestamp
