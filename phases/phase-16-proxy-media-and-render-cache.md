# Phase 16: Proxy Media, Optimized Media and Render Cache

Reference: Resolve generates proxies and optimized media from the Media Pool, caches rendered effects, and renders the final file from the original media.

## Proxies
- Generate proxy files at 1/2, 1/4 or a chosen height with WebCodecs encode in a worker; progress per clip
- Automatic proxy suggestion when a clip is larger than 1080p or the decoder falls behind
- Project toggle: Use proxies for playback; the badge on clips shows which version plays

## Optimized media
- Transcode heavy or all-intra-unfriendly sources to an easy-to-seek format (short GOP H.264)
- Store under OPFS with a size limit and a manage dialog

## Render cache
- Cache composited frames for regions with heavy effects; mark cached ranges on the ruler
- Invalidate exactly the affected range when a clip, effect or keyframe changes
- Smart mode: cache only ranges that failed to play in real time

## Settings and housekeeping
- Project settings: proxy resolution, cache size, location choice where the browser allows it
- Clear cache, see usage per project, remove unused proxies
- Final export always uses the original media unless the user explicitly chooses otherwise

## Done when
- A 4K source edits smoothly with proxies on and exports from the original
- Changing one clip invalidates only its cache range
- Cache stays under the configured size
