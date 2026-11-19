# Phase 26: Deliver: Render Queue and Presets

Reference: Resolve's Deliver page uses presets and a render queue. Cutir exports one file at a time today.

## Presets
- Built-in: YouTube 1080p and 4K, Shorts and Reels 9:16, Instagram square, Twitter, high quality archive, audio only, GIF and PNG sequence
- Save and import presets; each stores codec, bitrate mode, resolution, frame rate, audio settings and filename pattern

## Codecs and containers
- H.264, HEVC, VP9 and AV1 where WebCodecs supports them, with a capability check and a clear message when a codec is unavailable
- MP4 and WebM via mediabunny, audio as AAC, Opus, WAV or FLAC
- Constant quality and target bitrate modes, keyframe interval, two-pass where possible

## Queue
- Add jobs from the current timeline, a range, or several timelines; reorder, pause, cancel, retry
- Runs in a worker so the editor stays usable; keeps going after the dialog closes and survives a reload where possible
- Notifications and a finished list with save, reveal and re-render

## Options
- Export range (whole, in and out, selected clips), individual clips, audio stems per track
- Source selection: original, proxy or optimized media, matching Resolve's explicit choice
- Burn in subtitles, add a watermark, upload-ready metadata

## Verification
- Check the output: duration, frame count, audio sync and a test decode of the first and last frames

## Done when
- Three presets render as a queue in the background
- A failed job can be retried without losing the others
- Output files play correctly in common players and upload sites
